using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record PurchaseLineInput(string LineType, Guid? ProductId, Guid? MaterialId, string? BatchNo,
    long Quantity, decimal Rate, DateOnly? MfgDate, DateOnly? ExpiryDate);

public record PurchaseInput(Guid SupplierId, string? SupplierInvoiceNo, DateOnly PurchaseDate, decimal TransportCost,
    decimal DiscountAmount, decimal TaxAmount, decimal AmountPaid, string? PaymentMethod, Guid? PaymentAccountId,
    string? Notes, string? AttachmentUrl, List<PurchaseLineInput> Lines);

/// <summary>
/// Purchases of bulk spice (quantity in grams, rate per kg) and packaging materials (units, rate per unit).
/// Transport, tax and discount are allocated to lines by value to give a landed cost per gram / unit.
/// </summary>
public class PurchaseService
{
    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;
    private readonly FinanceService _finance;

    public PurchaseService(AppDbContext db, PostingService post, ICurrentUser user, FinanceService finance)
    { _db = db; _post = post; _user = user; _finance = finance; }

    public static DateTime DocTime(DateOnly d) => d.ToDateTime(new TimeOnly(7, 0), DateTimeKind.Utc); // 12:00 Pakistan time

    public async Task<PostResult> CreateAsync(PurchaseInput input)
    {
        _user.Require(Perm.PurchasesManage);
        if (input.Lines == null || input.Lines.Count == 0) throw new AppException("no_lines", "A purchase needs at least one line.");
        if (input.TransportCost < 0 || input.DiscountAmount < 0 || input.TaxAmount < 0 || input.AmountPaid < 0)
            throw new AppException("bad_amount", "Amounts cannot be negative.");

        var supplier = await _db.Suppliers.FirstOrDefaultAsync(s => s.Id == input.SupplierId && s.BusinessId == _user.BusinessId)
                       ?? throw AppException.NotFound("Supplier");
        var number = await _post.NextNumberAsync("PURCHASE", "PUR");
        var at = DocTime(input.PurchaseDate);

        var p = new Purchase
        {
            BusinessId = _user.BusinessId, PurchaseNo = number, SupplierId = supplier.Id, SupplierInvoiceNo = input.SupplierInvoiceNo,
            PurchaseDate = input.PurchaseDate, TransportCost = Money.R2(input.TransportCost), DiscountAmount = Money.R2(input.DiscountAmount),
            TaxAmount = Money.R2(input.TaxAmount), Notes = input.Notes, AttachmentUrl = input.AttachmentUrl, CreatedBy = _user.UserId
        };

        var n = 0;
        foreach (var l in input.Lines)
        {
            var type = Methods.Upper(l.LineType);
            if (type != "SPICE" && type != "MATERIAL") throw new AppException("bad_line_type", "Line type must be SPICE or MATERIAL.");
            if (l.Quantity <= 0) throw new AppException("bad_quantity", "Quantities must be greater than zero.");
            if (l.Rate < 0) throw new AppException("bad_rate", "Rates cannot be negative.");
            var total = type == "SPICE" ? Money.R2(l.Quantity / 1000m * l.Rate) : Money.R2(l.Quantity * l.Rate);
            p.Lines.Add(new PurchaseLine
            {
                PurchaseId = p.Id, LineNo = ++n, LineType = type, ProductId = type == "SPICE" ? l.ProductId : null,
                MaterialId = type == "MATERIAL" ? l.MaterialId : null, BatchNo = l.BatchNo?.Trim(), Quantity = l.Quantity,
                Rate = l.Rate, LineTotal = total, MfgDate = l.MfgDate, ExpiryDate = l.ExpiryDate
            });
        }

        p.SubTotal = p.Lines.Sum(x => x.LineTotal);
        p.Total = p.SubTotal + p.TransportCost + p.TaxAmount - p.DiscountAmount;
        if (p.Total < 0) throw new AppException("bad_total", "Discount cannot exceed the purchase value.");
        p.AmountPaid = Money.R2(input.AmountPaid);
        if (p.AmountPaid > p.Total) throw new AppException("overpaid", "Amount paid cannot exceed the purchase total. Record an advance as a separate supplier payment.");

        // Allocate extra cost (transport + tax - discount) to lines by value; the last line takes the rounding remainder.
        var extra = p.TransportCost + p.TaxAmount - p.DiscountAmount;
        decimal allocated = 0;
        for (var i = 0; i < p.Lines.Count; i++)
        {
            var line = p.Lines[i];
            line.LandedCost = i == p.Lines.Count - 1 ? extra - allocated
                : (p.SubTotal == 0 ? 0 : Money.R2(extra * line.LineTotal / p.SubTotal));
            allocated += line.LandedCost;
        }

        _db.Purchases.Add(p);
        await _db.SaveChangesAsync();

        foreach (var line in p.Lines)
        {
            var cost = line.LineTotal + line.LandedCost;
            if (line.LineType == "SPICE")
            {
                var product = await _db.Products.FirstOrDefaultAsync(x => x.Id == line.ProductId && x.BusinessId == _user.BusinessId)
                              ?? throw AppException.NotFound("Product");
                if (product.TrackExpiry && line.ExpiryDate is null)
                    throw new AppException("expiry_required", $"{product.Name} tracks expiry; enter an expiry date.");
                var batchNo = string.IsNullOrWhiteSpace(line.BatchNo) ? $"{number}-{line.LineNo}" : line.BatchNo!;
                if (await _db.Batches.AnyAsync(b => b.BusinessId == _user.BusinessId && b.ProductId == product.Id && b.BatchNo == batchNo))
                    throw AppException.Conflict($"Batch {batchNo} already exists for {product.Name}.");
                var batch = new Batch
                {
                    BusinessId = _user.BusinessId, ProductId = product.Id, BatchNo = batchNo, SupplierId = supplier.Id, PurchaseLineId = line.Id,
                    ReceivedGrams = line.Quantity, UnitCostPerGram = Money.R6(cost / line.Quantity), MfgDate = line.MfgDate,
                    ExpiryDate = line.ExpiryDate, ReceivedAt = at
                };
                _db.Batches.Add(batch);
                await _db.SaveChangesAsync(); // batch must exist before rows that reference it
                line.BatchId = batch.Id;
                line.BatchNo = batchNo;
                _post.Bulk(product.Id, batch.Id, line.Quantity, batch.UnitCostPerGram, "PURCHASE", "Purchase", p.Id, at, $"Purchase {number}");
            }
            else
            {
                var m = await _db.PackagingMaterials.FirstOrDefaultAsync(x => x.Id == line.MaterialId && x.BusinessId == _user.BusinessId)
                        ?? throw AppException.NotFound("Packaging material");
                await _post.MaterialInAsync(m, line.Quantity, cost / line.Quantity, "PURCHASE", "Purchase", p.Id, at, $"Purchase {number}");
            }
        }

        _post.SupplierEntry(supplier.Id, "PURCHASE", 0, p.Total, "Purchase", p.Id, at, $"Purchase {number}" + (p.SupplierInvoiceNo is null ? "" : $" (bill {p.SupplierInvoiceNo})"));
        _post.Audit("CREATE", "Purchase", p.Id, $"Purchase {number} from {supplier.Name}, total {p.Total:0.00}");
        await _db.SaveChangesAsync();

        if (p.AmountPaid > 0)
        {
            var method = string.IsNullOrWhiteSpace(input.PaymentMethod) ? "CASH" : input.PaymentMethod!;
            var pay = await _finance.PostSupplierPaymentAsync(new SupplierPaymentInput(supplier.Id, p.Id, at, p.AmountPaid, method,
                input.PaymentAccountId, $"Paid on {number}", null), internalCall: true);
            p.PaymentAccountId = (await _db.SupplierPayments.FirstAsync(x => x.Id == pay.Id)).AccountId;
            await _db.SaveChangesAsync();
        }
        return PostResult.Applied(p.Id, number);
    }

    /// <summary>Cancels a purchase by reversal. Only possible while none of its stock has been used.</summary>
    public async Task CancelAsync(Guid id, string reason)
    {
        _user.Require(Perm.PurchasesManage);
        if (string.IsNullOrWhiteSpace(reason)) throw new AppException("reason_required", "A cancellation reason is required.");
        var p = await _db.Purchases.Include(x => x.Lines).FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
                ?? throw AppException.NotFound("Purchase");
        if (p.Status != "POSTED") throw new AppException("bad_status", "Only posted purchases can be cancelled.");
        var now = DateTime.UtcNow;

        foreach (var line in p.Lines)
        {
            if (line.LineType == "SPICE")
            {
                var batch = await _db.Batches.FirstAsync(b => b.Id == line.BatchId);
                await _post.LockAsync("Batches", new[] { batch.Id });
                var grams = await _post.BatchGramsAsync(batch.Id);
                if (grams != line.Quantity)
                    throw new AppException("stock_used", $"Batch {batch.BatchNo} has already been used or adjusted; the purchase cannot be cancelled. Use a stock adjustment instead.");
                _post.Bulk(batch.ProductId, batch.Id, -line.Quantity, batch.UnitCostPerGram, "PURCHASE_CANCEL", "Purchase", p.Id, now, reason);
                batch.IsClosed = true;
            }
            else
            {
                var m = await _db.PackagingMaterials.FirstAsync(x => x.Id == line.MaterialId);
                await _post.LockAsync("PackagingMaterials", new[] { m.Id });
                var qty = await _post.MaterialQtyAsync(m.Id);
                if (qty < line.Quantity)
                    throw new AppException("stock_used", $"{m.Name}: only {qty} in stock; the purchase cannot be cancelled.");
                await _post.MaterialReverseInboundAsync(m, line.Quantity, (line.LineTotal + line.LandedCost) / line.Quantity, "PURCHASE_CANCEL", "Purchase", p.Id, now, reason);
            }
        }

        _post.SupplierEntry(p.SupplierId, "PURCHASE_CANCEL", p.Total, 0, "Purchase", p.Id, now, $"Cancelled purchase {p.PurchaseNo}: {reason}");
        p.Status = "CANCELLED"; p.CancelledAt = now; p.CancelledBy = _user.UserId; p.CancelReason = reason;
        _post.Audit("CANCEL", "Purchase", p.Id, $"Purchase {p.PurchaseNo} cancelled: {reason}. Payments remain as supplier advance.");
        await _db.SaveChangesAsync();
    }
}
