using System.Text.Json;
using Dapper;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record SyncOperation(Guid OpId, string Type, JsonElement Payload, DateTime CreatedAt);
public record SyncPushRequest(Guid DeviceId, List<SyncOperation> Operations);
public record SyncOpResult(Guid OpId, string Status, Guid? EntityId, string? Number, string? Message, List<string> Warnings, bool Duplicate, object? Server);

/// <summary>
/// Offline sync engine (server side).
///
/// PUSH: operations are applied strictly in the order the device created them. Each operation runs in
/// its own database transaction which also inserts its idempotency key; a retried operation (e.g. after
/// a timeout where the server had already committed) finds the key and gets the original result back,
/// so nothing is ever posted twice. Business-rule rejections are stored too, so retries are deterministic.
///
/// PULL: master data changed since the device cursor, plus authoritative stock and balance snapshots.
/// Devices never overwrite stock quantities — they send movements (as documents) and receive balances.
/// </summary>
public class SyncService
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IServiceProvider _sp;
    private readonly NpgsqlDataSource _ds;
    private readonly ILogger<SyncService> _log;

    public static readonly string[] SupportedTypes =
        { "customer.upsert", "invoice.create", "receipt.create", "expense.create", "return.create", "delivery.stop.update" };

    public SyncService(AppDbContext db, ICurrentUser user, IServiceProvider sp, NpgsqlDataSource ds, ILogger<SyncService> log)
    { _db = db; _user = user; _sp = sp; _ds = ds; _log = log; }

    public async Task<Device> RequireDeviceAsync(Guid deviceId)
    {
        if (_user.DeviceId != deviceId) throw new AppException("device_mismatch", "This session belongs to another device. Sign in again.", 403);
        var device = await _db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId && d.BusinessId == _user.BusinessId)
                     ?? throw new AppException("device_unknown", "This device is not registered.", 403);
        if (device.IsRevoked) throw new AppException("device_revoked", "This device has been revoked by the owner. Unsynced records are kept on the device; contact the owner.", 403);
        return device;
    }

    public async Task<object> PushAsync(SyncPushRequest req)
    {
        var device = await RequireDeviceAsync(req.DeviceId);
        if (req.Operations == null || req.Operations.Count == 0) return new { results = new List<SyncOpResult>() };
        if (req.Operations.Count > 200) throw new AppException("too_many", "Send at most 200 operations per request.");

        var batch = new SyncBatch { BusinessId = _user.BusinessId, DeviceId = device.Id, UserId = _user.UserId, OperationCount = req.Operations.Count };
        var results = new List<SyncOpResult>();

        foreach (var op in req.Operations)
        {
            var result = await ApplyOneAsync(op);
            results.Add(result);
            if (result.Duplicate) batch.DuplicateCount++;
            else if (result.Status == "applied") batch.AppliedCount++;
            else if (result.Status == "conflict") batch.ConflictCount++;
            else batch.RejectedCount++;
        }

        _db.ChangeTracker.Clear();
        _db.SyncBatches.Add(batch);
        var dev = await _db.Devices.FirstAsync(d => d.Id == device.Id);
        dev.LastPushAt = DateTime.UtcNow; dev.LastSeenAt = DateTime.UtcNow; dev.LastUserId = _user.UserId;
        await _db.SaveChangesAsync();
        return new { results };
    }

    private async Task<SyncOpResult> ApplyOneAsync(SyncOperation op)
    {
        _db.ChangeTracker.Clear();
        var prior = await _db.ProcessedIdempotencyKeys.AsNoTracking().FirstOrDefaultAsync(k => k.Key == op.OpId);
        if (prior != null) return Replay(prior);

        if (!SupportedTypes.Contains(op.Type))
            return await StoreRejection(op, $"Unsupported operation type '{op.Type}'.");

        try
        {
            await using var tx = await _db.Database.BeginTransactionAsync();
            var r = await DispatchAsync(op);
            var status = r.Status == "conflict" ? "conflict" : "applied";
            var result = new SyncOpResult(op.OpId, status, r.Id, r.Number, null, r.Warnings, r.Status == "duplicate", r.Data);
            _db.ProcessedIdempotencyKeys.Add(new ProcessedIdempotencyKey
            {
                Key = op.OpId, BusinessId = _user.BusinessId, DeviceId = _user.DeviceId, OperationType = op.Type,
                Status = status, ResultJson = JsonSerializer.Serialize(result, JsonDefaults.Options)
            });
            await _db.SaveChangesAsync();
            await tx.CommitAsync();
            return result;
        }
        catch (AppException ex) when (ex.StatusCode is 400 or 403 or 404 or 409)
        {
            _db.ChangeTracker.Clear();
            return await StoreRejection(op, ex.Message);
        }
        catch (JsonException ex)
        {
            _db.ChangeTracker.Clear();
            return await StoreRejection(op, $"Malformed payload: {ex.Message}");
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            // Another request committed the same operation concurrently: return its stored result.
            _db.ChangeTracker.Clear();
            var again = await _db.ProcessedIdempotencyKeys.AsNoTracking().FirstOrDefaultAsync(k => k.Key == op.OpId);
            if (again != null) return Replay(again);
            return await StoreRejection(op, "A record with the same unique value already exists.");
        }
    }

    private static SyncOpResult Replay(ProcessedIdempotencyKey prior)
    {
        var stored = JsonSerializer.Deserialize<SyncOpResult>(prior.ResultJson, JsonDefaults.Options)!;
        return stored with { Duplicate = true };
    }

    private async Task<SyncOpResult> StoreRejection(SyncOperation op, string message)
    {
        _log.LogWarning("Sync op {OpId} ({Type}) rejected: {Message}", op.OpId, op.Type, message);
        var result = new SyncOpResult(op.OpId, "rejected", null, null, message, new List<string>(), false, null);
        _db.ProcessedIdempotencyKeys.Add(new ProcessedIdempotencyKey
        {
            Key = op.OpId, BusinessId = _user.BusinessId, DeviceId = _user.DeviceId, OperationType = op.Type,
            Status = "rejected", ResultJson = JsonSerializer.Serialize(result, JsonDefaults.Options)
        });
        _db.SyncConflicts.Add(new SyncConflict
        {
            BusinessId = _user.BusinessId, DeviceId = _user.DeviceId, OperationKey = op.OpId, ConflictType = "REJECTED",
            EntityType = op.Type, Details = message
        });
        await _db.SaveChangesAsync();
        _db.ChangeTracker.Clear();
        return result;
    }

    private T Payload<T>(SyncOperation op) =>
        op.Payload.Deserialize<T>(JsonDefaults.Options) ?? throw new AppException("bad_payload", "Empty payload.");

    private async Task<PostResult> DispatchAsync(SyncOperation op)
    {
        switch (op.Type)
        {
            case "customer.upsert": return await _sp.GetRequiredService<CustomerService>().UpsertAsync(Payload<CustomerInput>(op), op.OpId);
            case "invoice.create": return await _sp.GetRequiredService<SalesService>().PostInvoiceAsync(Payload<InvoiceInput>(op), op.OpId);
            case "receipt.create": return await _sp.GetRequiredService<FinanceService>().PostReceiptAsync(Payload<ReceiptInput>(op));
            case "expense.create": return await _sp.GetRequiredService<FinanceService>().PostExpenseAsync(Payload<ExpenseInput>(op));
            case "return.create": return await _sp.GetRequiredService<SalesService>().CreateReturnAsync(Payload<ReturnInput>(op));
            case "delivery.stop.update": return await _sp.GetRequiredService<DeliveryService>().UpdateStopAsync(Payload<StopUpdateInput>(op));
            default: throw new AppException("bad_type", "Unsupported operation.");
        }
    }

    // ------------------------------------------------------------------ pull
    public async Task<object> PullAsync(Guid deviceId, DateTime? since)
    {
        var device = await RequireDeviceAsync(deviceId);
        var serverTime = DateTime.UtcNow;
        var b = _user.BusinessId;
        // Pull a little earlier than the cursor so rows committed during the previous pull are not missed.
        var s = since.HasValue ? since.Value.ToUniversalTime().AddMinutes(-2) : new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var me = _user.UserId;
        var seeAllCustomers = _user.Has(Perm.SalesCancel) || _user.Has(Perm.ReportsFinancial) || _user.Has(Perm.DeliveryManage);

        await using var conn = await _ds.OpenConnectionAsync();

        var business = await conn.QuerySingleAsync(@"SELECT ""Id"" id, ""Name"" name, ""NameUr"" ""nameUr"", ""Address"" address, ""AddressUr"" ""addressUr"",
            ""Phone"" phone, ""LogoUrl"" ""logoUrl"", ""InvoiceTerms"" ""invoiceTerms"", ""InvoiceTermsUr"" ""invoiceTermsUr"",
            ""CurrencySymbol"" ""currencySymbol"", ""AllowNegativeStock"" ""allowNegativeStock"", ""TimeZone"" ""timeZone""
            FROM ""Businesses"" WHERE ""Id"" = @b", new { b });

        var categories = await conn.QueryAsync(@"SELECT ""Id"" id, ""Name"" name, ""NameUr"" ""nameUr"", ""IsActive"" ""isActive""
            FROM ""ProductCategories"" WHERE ""BusinessId"" = @b AND ""UpdatedAt"" > @s", new { b, s });

        var products = await conn.QueryAsync(@"SELECT ""Id"" id, ""CategoryId"" ""categoryId"", ""Code"" code, ""Name"" name, ""NameUr"" ""nameUr"",
            ""SpiceType"" ""spiceType"", ""Brand"" brand, ""Barcode"" barcode, ""TaxRate"" ""taxRate"", ""ImageUrl"" ""imageUrl"",
            ""MinStockGrams"" ""minStockGrams"", ""TrackExpiry"" ""trackExpiry"", ""IsActive"" ""isActive"", ""Version"" version
            FROM ""Products"" WHERE ""BusinessId"" = @b AND ""UpdatedAt"" > @s", new { b, s });

        var variations = await conn.QueryAsync(@"SELECT ""Id"" id, ""ProductId"" ""productId"", ""Sku"" sku, ""Barcode"" barcode,
            ""PacketGrams"" ""packetGrams"", ""RetailPrice"" ""retailPrice"", ""WholesalePrice"" ""wholesalePrice"", ""DealerPrice"" ""dealerPrice"",
            ""MinPrice"" ""minPrice"", ""MinStockPackets"" ""minStockPackets"", ""IsActive"" ""isActive"", ""Version"" version
            FROM ""ProductVariations"" WHERE ""BusinessId"" = @b AND ""UpdatedAt"" > @s", new { b, s });

        var customers = await conn.QueryAsync(@"SELECT c.""Id"" id, c.""Code"" code, c.""ShopName"" ""shopName"", c.""ContactPerson"" ""contactPerson"",
            c.""Phone"" phone, c.""WhatsApp"" ""whatsApp"", c.""Address"" address, c.""Area"" area, c.""City"" city, c.""CustomerType"" ""customerType"",
            c.""SalespersonId"" ""salespersonId"", c.""RouteId"" ""routeId"", c.""CreditLimit"" ""creditLimit"", c.""PaymentTermsDays"" ""paymentTermsDays"",
            c.""IsActive"" ""isActive"", c.""Version"" version, c.""Notes"" notes
            FROM ""Customers"" c LEFT JOIN ""DeliveryRoutes"" r ON r.""Id"" = c.""RouteId""
            WHERE c.""BusinessId"" = @b AND c.""UpdatedAt"" > @s
              AND (@all OR c.""SalespersonId"" IS NULL OR c.""SalespersonId"" = @me OR r.""DefaultUserId"" = @me)",
            new { b, s, all = seeAllCustomers, me });

        var routes = await conn.QueryAsync(@"SELECT ""Id"" id, ""Name"" name, ""Area"" area, ""IsActive"" ""isActive"" FROM ""DeliveryRoutes"" WHERE ""BusinessId"" = @b", new { b });
        var accounts = await conn.QueryAsync(@"SELECT ""Id"" id, ""Name"" name, ""NameUr"" ""nameUr"", ""Kind"" kind, ""IsActive"" ""isActive"" FROM ""CashAccounts"" WHERE ""BusinessId"" = @b", new { b });
        var users = await conn.QueryAsync(@"SELECT ""Id"" id, ""FullName"" ""fullName"", ""IsActive"" ""isActive"" FROM ""Users"" WHERE ""BusinessId"" = @b", new { b });

        // Authoritative snapshots — the device replaces its local copy with these.
        var finished = await conn.QueryAsync(@"SELECT ""VariationId"" ""variationId"", ""Packets"" packets FROM ""vFinishedStock"" WHERE ""BusinessId"" = @b", new { b });
        var bulk = await conn.QueryAsync(@"SELECT ""ProductId"" ""productId"", SUM(""Grams"")::bigint grams FROM ""vBulkStock"" WHERE ""BusinessId"" = @b GROUP BY ""ProductId""", new { b });
        var balances = await conn.QueryAsync(@"SELECT ""CustomerId"" ""customerId"", ""Balance"" balance FROM ""vCustomerBalances"" WHERE ""BusinessId"" = @b AND ""Balance"" <> 0", new { b });

        var invoices = await conn.QueryAsync(@"SELECT i.""Id"" id, i.""InvoiceNo"" ""invoiceNo"", i.""InvoiceDate"" ""invoiceDate"", i.""CustomerId"" ""customerId"",
            i.""SalespersonId"" ""salespersonId"", i.""Status"" status, i.""PaymentMethod"" ""paymentMethod"", i.""SubTotal"" ""subTotal"",
            i.""DiscountAmount"" ""discountAmount"", i.""TaxAmount"" ""taxAmount"", i.""Total"" total, i.""PreviousBalance"" ""previousBalance"",
            i.""AmountPaid"" ""amountPaid"", i.""BalanceAfter"" ""balanceAfter"", i.""ReturnedAmount"" ""returnedAmount"",
            i.""DeliveryStatus"" ""deliveryStatus"", i.""Notes"" notes, COALESCE(o.""OpenAmount"", 0) ""openAmount"",
            (SELECT json_agg(json_build_object('id', l.""Id"", 'variationId', l.""VariationId"", 'productId', l.""ProductId"",
                 'description', l.""Description"", 'descriptionUr', l.""DescriptionUr"", 'packetGrams', l.""PacketGrams"",
                 'quantity', l.""Quantity"", 'unitPrice', l.""UnitPrice"", 'discountAmount', l.""DiscountAmount"",
                 'taxAmount', l.""TaxAmount"", 'lineTotal', l.""LineTotal"", 'returnedQty', l.""ReturnedQty"") ORDER BY l.""LineNo"")
             FROM ""SalesInvoiceLines"" l WHERE l.""InvoiceId"" = i.""Id"")::text ""linesJson""
            FROM ""SalesInvoices"" i
            JOIN ""Customers"" c ON c.""Id"" = i.""CustomerId""
            LEFT JOIN ""DeliveryRoutes"" r ON r.""Id"" = c.""RouteId""
            LEFT JOIN ""vInvoiceOpenAmounts"" o ON o.""InvoiceId"" = i.""Id""
            WHERE i.""BusinessId"" = @b AND i.""InvoiceDate"" > now() - interval '60 days'
              AND (@all OR c.""SalespersonId"" IS NULL OR c.""SalespersonId"" = @me OR r.""DefaultUserId"" = @me OR i.""SalespersonId"" = @me)
            ORDER BY i.""InvoiceDate"" DESC LIMIT 500", new { b, all = seeAllCustomers, me });

        var deliveries = await conn.QueryAsync(@"SELECT d.""Id"" id, d.""DeliveryNo"" ""deliveryNo"", d.""DeliveryDate"" ""deliveryDate"", d.""Status"" status,
            d.""Vehicle"" vehicle, r.""Name"" ""routeName"",
            (SELECT json_agg(json_build_object('id', s.""Id"", 'seq', s.""Seq"", 'customerId', s.""CustomerId"", 'invoiceId', s.""InvoiceId"",
                 'status', s.""Status"", 'expectedCollection', s.""ExpectedCollection"", 'collectedAmount', s.""CollectedAmount"",
                 'lines', (SELECT json_agg(json_build_object('id', dl.""Id"", 'variationId', dl.""VariationId"", 'loadedQty', dl.""LoadedQty"",
                           'deliveredQty', dl.""DeliveredQty"", 'returnedQty', dl.""ReturnedQty"")) FROM ""DeliveryLines"" dl WHERE dl.""StopId"" = s.""Id""))
                 ORDER BY s.""Seq"")
             FROM ""DeliveryStops"" s WHERE s.""DeliveryId"" = d.""Id"")::text ""stopsJson""
            FROM ""Deliveries"" d JOIN ""DeliveryRoutes"" r ON r.""Id"" = d.""RouteId""
            WHERE d.""BusinessId"" = @b AND d.""AssignedUserId"" = @me AND d.""Status"" <> 'COMPLETED'", new { b, me });

        var openConflicts = await conn.ExecuteScalarAsync<int>(@"SELECT count(*) FROM ""SyncConflicts"" WHERE ""BusinessId"" = @b AND ""Status"" = 'OPEN'", new { b });

        var dev = await _db.Devices.FirstAsync(d => d.Id == device.Id);
        dev.LastPullAt = serverTime; dev.LastSeenAt = serverTime;
        await _db.SaveChangesAsync();

        return new
        {
            serverTime, full = since == null, device = new { id = device.Id, prefix = device.Prefix, name = device.Name },
            business, categories, products, variations, customers, routes, accounts, users,
            stock = new { finished, bulk }, balances, invoices, deliveries, openConflicts
        };
    }
}
