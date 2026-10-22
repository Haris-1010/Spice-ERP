using System.Data;
using Dapper;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;

namespace SpiceErp.Api.Services;

/// <summary>
/// The single place where stock, ledgers, cash and audit rows are written. Every business
/// service posts through here inside a database transaction, so the rules for stock and
/// money exist exactly once.
///
/// Costing policy (documented in README):
///  * Bulk spice: specific batch cost (UnitCostPerGram incl. landed cost).
///  * Finished packets and packaging materials: moving weighted average, updated on every inbound movement.
/// </summary>
public class PostingService
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;

    public PostingService(AppDbContext db, ICurrentUser user) { _db = db; _user = user; }

    public AppDbContext Db => _db;

    // ------------------------------------------------------------ transactions & locks
    public Task<IDbContextTransaction> BeginAsync() => _db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted);

    /// <summary>Row-locks the given ids (SELECT ... FOR UPDATE) to serialise stock/balance checks.</summary>
    public async Task LockAsync(string table, IEnumerable<Guid> ids)
    {
        var arr = ids.Distinct().ToArray();
        if (arr.Length == 0) return;
        await _db.Database.ExecuteSqlRawAsync($"SELECT 1 FROM \"{table}\" WHERE \"Id\" = ANY({{0}}) FOR UPDATE", new object[] { arr });
    }

    /// <summary>Allocates the next server document number, e.g. PUR-00042 (runs inside the current transaction).</summary>
    public async Task<string> NextNumberAsync(string docType, string prefix)
    {
        var conn = _db.Database.GetDbConnection();
        if (conn.State != ConnectionState.Open) await _db.Database.OpenConnectionAsync();
        var tx = _db.Database.CurrentTransaction?.GetDbTransaction();
        var n = await conn.ExecuteScalarAsync<long>(
            @"INSERT INTO ""DocumentSequences"" (""BusinessId"",""DocType"",""Prefix"",""NextValue"") VALUES (@b,@t,@p,2)
              ON CONFLICT (""BusinessId"",""DocType"") DO UPDATE SET ""NextValue"" = ""DocumentSequences"".""NextValue"" + 1
              RETURNING ""NextValue"" - 1",
            new { b = _user.BusinessId, t = docType, p = prefix }, tx);
        return $"{prefix}-{n:D5}";
    }

    public async Task<Business> BusinessAsync() =>
        await _db.Businesses.FirstAsync(x => x.Id == _user.BusinessId);

    // ------------------------------------------------------------ stock queries (posted rows)
    public async Task<long> BatchGramsAsync(Guid batchId) =>
        await _db.InventoryTransactions.Where(t => t.BatchId == batchId && t.Bucket == "BULK").SumAsync(t => (long?)t.Quantity) ?? 0;

    public async Task<long> FinishedPacketsAsync(Guid variationId) =>
        await _db.InventoryTransactions.Where(t => t.VariationId == variationId && t.Bucket == "FINISHED").SumAsync(t => (long?)t.Quantity) ?? 0;

    public async Task<long> DamagedPacketsAsync(Guid variationId) =>
        await _db.InventoryTransactions.Where(t => t.VariationId == variationId && t.Bucket == "DAMAGED" && t.Unit == "PKT").SumAsync(t => (long?)t.Quantity) ?? 0;

    public async Task<long> MaterialQtyAsync(Guid materialId) =>
        await _db.PackagingMaterialTransactions.Where(t => t.MaterialId == materialId).SumAsync(t => (long?)t.Quantity) ?? 0;

    public async Task<decimal> CustomerBalanceAsync(Guid customerId) =>
        await _db.CustomerLedgerEntries.Where(e => e.CustomerId == customerId).SumAsync(e => (decimal?)(e.Debit - e.Credit)) ?? 0m;

    public async Task<decimal> SupplierBalanceAsync(Guid supplierId) =>
        await _db.SupplierLedgerEntries.Where(e => e.SupplierId == supplierId).SumAsync(e => (decimal?)(e.Credit - e.Debit)) ?? 0m;

    // ------------------------------------------------------------ stock movements
    private InventoryTransaction Move(string bucket, string unit, Guid productId, Guid? variationId, Guid? batchId,
        long qty, decimal unitCost, string type, string srcType, Guid srcId, DateTime at, string? reason)
    {
        if (qty == 0) throw new AppException("zero_quantity", "Stock movement quantity cannot be zero.");
        var t = new InventoryTransaction
        {
            BusinessId = _user.BusinessId, OccurredAt = at, Bucket = bucket, Unit = unit, ProductId = productId,
            VariationId = variationId, BatchId = batchId, Quantity = qty, UnitCost = Money.R6(unitCost),
            MovementType = type, SourceType = srcType, SourceId = srcId, Reason = reason,
            CreatedBy = _user.UserId, DeviceId = _user.DeviceId
        };
        _db.InventoryTransactions.Add(t);
        return t;
    }

    public void Bulk(Guid productId, Guid batchId, long grams, decimal costPerGram, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
        => Move("BULK", "G", productId, null, batchId, grams, costPerGram, type, srcType, srcId, at, reason);

    public void Damaged(Guid productId, Guid? variationId, string unit, long qty, decimal unitCost, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
        => Move("DAMAGED", unit, productId, variationId, null, qty, unitCost, type, srcType, srcId, at, reason);

    /// <summary>Adds packets to saleable stock and updates the weighted-average cost.</summary>
    public async Task FinishedInAsync(ProductVariation v, long packets, decimal unitCost, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        if (packets <= 0) throw new AppException("bad_quantity", "Inbound quantity must be positive.");
        await _db.SaveChangesAsync();
        var onHand = await FinishedPacketsAsync(v.Id);
        var basis = Math.Max(onHand, 0);
        v.AvgUnitCost = basis + packets == 0 ? unitCost : Money.R6((basis * v.AvgUnitCost + packets * unitCost) / (basis + packets));
        v.UpdatedAt = DateTime.UtcNow;
        Move("FINISHED", "PKT", v.ProductId, v.Id, null, packets, unitCost, type, srcType, srcId, at, reason);
    }

    /// <summary>Removes packets from saleable stock at the current average cost. Returns the unit cost used.</summary>
    public decimal FinishedOut(ProductVariation v, long packets, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        if (packets <= 0) throw new AppException("bad_quantity", "Outbound quantity must be positive.");
        Move("FINISHED", "PKT", v.ProductId, v.Id, null, -packets, v.AvgUnitCost, type, srcType, srcId, at, reason);
        return v.AvgUnitCost;
    }

    /// <summary>Reverses an earlier inbound at its original cost (e.g. cancelling a packing order).</summary>
    public async Task FinishedReverseInboundAsync(ProductVariation v, long packets, decimal originalUnitCost, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        await _db.SaveChangesAsync();
        var onHand = await FinishedPacketsAsync(v.Id);
        var remaining = onHand - packets;
        if (remaining > 0)
            v.AvgUnitCost = Math.Max(0, Money.R6((onHand * v.AvgUnitCost - packets * originalUnitCost) / remaining));
        v.UpdatedAt = DateTime.UtcNow;
        Move("FINISHED", "PKT", v.ProductId, v.Id, null, -packets, originalUnitCost, type, srcType, srcId, at, reason);
    }

    public async Task MaterialInAsync(PackagingMaterial m, long qty, decimal unitCost, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        if (qty <= 0) throw new AppException("bad_quantity", "Inbound quantity must be positive.");
        await _db.SaveChangesAsync();
        var onHand = Math.Max(await MaterialQtyAsync(m.Id), 0);
        m.AvgUnitCost = onHand + qty == 0 ? unitCost : Money.R6((onHand * m.AvgUnitCost + qty * unitCost) / (onHand + qty));
        m.UpdatedAt = DateTime.UtcNow;
        AddMaterialTx(m.Id, qty, unitCost, type, srcType, srcId, at, reason);
    }

    /// <summary>Reverses an earlier material inbound at its original cost (e.g. cancelling a purchase).</summary>
    public async Task MaterialReverseInboundAsync(PackagingMaterial m, long qty, decimal originalUnitCost, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        await _db.SaveChangesAsync();
        var onHand = await MaterialQtyAsync(m.Id);
        var remaining = onHand - qty;
        if (remaining > 0)
            m.AvgUnitCost = Math.Max(0, Money.R6((onHand * m.AvgUnitCost - qty * originalUnitCost) / remaining));
        m.UpdatedAt = DateTime.UtcNow;
        AddMaterialTx(m.Id, -qty, originalUnitCost, type, srcType, srcId, at, reason);
    }

    public decimal MaterialOut(PackagingMaterial m, long qty, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        if (qty <= 0) throw new AppException("bad_quantity", "Outbound quantity must be positive.");
        AddMaterialTx(m.Id, -qty, m.AvgUnitCost, type, srcType, srcId, at, reason);
        return m.AvgUnitCost;
    }

    public void AddMaterialTx(Guid materialId, long qty, decimal unitCost, string type, string srcType, Guid srcId, DateTime at, string? reason = null)
    {
        _db.PackagingMaterialTransactions.Add(new PackagingMaterialTransaction
        {
            BusinessId = _user.BusinessId, MaterialId = materialId, OccurredAt = at, Quantity = qty, UnitCost = Money.R6(unitCost),
            MovementType = type, SourceType = srcType, SourceId = srcId, Reason = reason, CreatedBy = _user.UserId
        });
    }

    // ------------------------------------------------------------ ledgers & cash
    public void CustomerEntry(Guid customerId, string entryType, decimal debit, decimal credit, string srcType, Guid srcId, DateTime at, string? desc)
    {
        if (debit == 0 && credit == 0) return;
        _db.CustomerLedgerEntries.Add(new CustomerLedgerEntry
        {
            BusinessId = _user.BusinessId, CustomerId = customerId, EntryType = entryType, Debit = Money.R2(debit), Credit = Money.R2(credit),
            SourceType = srcType, SourceId = srcId, EntryDate = at, Description = desc
        });
    }

    public void SupplierEntry(Guid supplierId, string entryType, decimal debit, decimal credit, string srcType, Guid srcId, DateTime at, string? desc)
    {
        if (debit == 0 && credit == 0) return;
        _db.SupplierLedgerEntries.Add(new SupplierLedgerEntry
        {
            BusinessId = _user.BusinessId, SupplierId = supplierId, EntryType = entryType, Debit = Money.R2(debit), Credit = Money.R2(credit),
            SourceType = srcType, SourceId = srcId, EntryDate = at, Description = desc
        });
    }

    public void Cash(Guid accountId, decimal amount, string srcType, Guid srcId, DateTime at, string? desc)
    {
        if (amount == 0) return;
        _db.CashTransactions.Add(new CashTransaction
        {
            BusinessId = _user.BusinessId, AccountId = accountId, Amount = Money.R2(amount), SourceType = srcType,
            SourceId = srcId, OccurredAt = at, Description = desc, CreatedBy = _user.UserId
        });
    }

    /// <summary>Resolves the cash/bank/wallet account for a payment method (explicit account wins).</summary>
    public async Task<CashAccount> AccountForAsync(string method, Guid? accountId)
    {
        CashAccount? acc;
        if (accountId.HasValue)
            acc = await _db.CashAccounts.FirstOrDefaultAsync(a => a.Id == accountId && a.BusinessId == _user.BusinessId && a.IsActive);
        else
            acc = await _db.CashAccounts.Where(a => a.BusinessId == _user.BusinessId && a.IsActive && a.Kind == method)
                .OrderBy(a => a.Name).FirstOrDefaultAsync();
        return acc ?? throw new AppException("no_account", $"No active {method.ToLowerInvariant()} account is configured.");
    }

    // ------------------------------------------------------------ audit
    public void Audit(string action, string entityType, object? entityId, string summary)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            BusinessId = _user.BusinessId, UserId = _user.UserId, DeviceId = _user.DeviceId, Action = action,
            EntityType = entityType, EntityId = entityId?.ToString(), Summary = summary, IpAddress = _user.IpAddress
        });
    }

    public void Conflict(string type, string entityType, Guid? entityId, string details, Guid? opKey = null)
    {
        _db.SyncConflicts.Add(new SyncConflict
        {
            BusinessId = _user.BusinessId, DeviceId = _user.DeviceId, OperationKey = opKey,
            ConflictType = type, EntityType = entityType, EntityId = entityId, Details = details
        });
    }

    // ------------------------------------------------------------ receipt allocation
    /// <summary>
    /// Keeps CustomerReceiptAllocations consistent: trims allocations that exceed an invoice's
    /// collectible amount (after returns or cancellation), then applies every unallocated receipt
    /// amount to open invoices — the receipt's preferred invoice first, then oldest first.
    /// </summary>
    public async Task ReallocateAsync(Guid customerId)
    {
        await _db.SaveChangesAsync();

        var invoices = await _db.SalesInvoices.Where(i => i.CustomerId == customerId)
            .Select(i => new
            {
                i.Id, i.InvoiceDate,
                Cap = i.Status == "POSTED" ? i.Total - i.ReturnedAmount : 0m,
                Allocated = _db.CustomerReceiptAllocations.Where(a => a.InvoiceId == i.Id).Sum(a => (decimal?)a.Amount) ?? 0m
            }).ToListAsync();

        foreach (var inv in invoices.Where(x => x.Allocated > x.Cap))
        {
            var excess = inv.Allocated - Math.Max(inv.Cap, 0);
            var allocs = await _db.CustomerReceiptAllocations.Where(a => a.InvoiceId == inv.Id).OrderByDescending(a => a.Amount).ToListAsync();
            foreach (var a in allocs)
            {
                if (excess <= 0) break;
                var cut = Math.Min(a.Amount, excess);
                excess -= cut;
                if (cut == a.Amount) _db.CustomerReceiptAllocations.Remove(a); else a.Amount -= cut;
            }
        }
        await _db.SaveChangesAsync();

        var open = await _db.SalesInvoices.Where(i => i.CustomerId == customerId && i.Status == "POSTED")
            .Select(i => new
            {
                i.Id, i.InvoiceDate,
                Open = i.Total - i.ReturnedAmount - (_db.CustomerReceiptAllocations.Where(a => a.InvoiceId == i.Id).Sum(a => (decimal?)a.Amount) ?? 0m)
            })
            .Where(x => x.Open > 0).OrderBy(x => x.InvoiceDate).ToListAsync();
        if (open.Count == 0) return;
        var openMap = open.ToDictionary(x => x.Id, x => x.Open);

        var receipts = await _db.CustomerReceipts.Where(r => r.CustomerId == customerId && r.Status == "POSTED")
            .Select(r => new
            {
                r.Id, r.InvoiceId, r.ReceiptDate,
                Free = r.Amount - (_db.CustomerReceiptAllocations.Where(a => a.ReceiptId == r.Id).Sum(a => (decimal?)a.Amount) ?? 0m)
            })
            .Where(x => x.Free > 0).OrderBy(x => x.ReceiptDate).ToListAsync();

        foreach (var r in receipts)
        {
            var free = r.Free;
            var order = new List<Guid>();
            if (r.InvoiceId.HasValue && openMap.ContainsKey(r.InvoiceId.Value)) order.Add(r.InvoiceId.Value);
            order.AddRange(open.Select(o => o.Id).Where(id => id != r.InvoiceId));
            foreach (var invId in order)
            {
                if (free <= 0) break;
                var avail = openMap[invId];
                if (avail <= 0) continue;
                var amt = Math.Min(avail, free);
                _db.CustomerReceiptAllocations.Add(new CustomerReceiptAllocation { ReceiptId = r.Id, InvoiceId = invId, Amount = amt });
                openMap[invId] = avail - amt;
                free -= amt;
            }
        }
        await _db.SaveChangesAsync();
    }
}
