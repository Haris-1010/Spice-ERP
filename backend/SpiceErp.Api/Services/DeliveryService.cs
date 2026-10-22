using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record DeliveryInput(Guid RouteId, DateOnly DeliveryDate, Guid AssignedUserId, string? Vehicle, string? Notes,
    List<Guid> InvoiceIds, List<Guid>? VisitCustomerIds);

public record StopLineInput(Guid LineId, int DeliveredQty);

public record StopUpdateInput(Guid StopId, string Status, List<StopLineInput>? Lines, string? FailReason,
    decimal CollectedAmount, string? CollectionMethod, Guid? ReceiptId, string? ReceiptNo, Guid? ReturnId, string? ReturnNo,
    string? AcknowledgedBy, string? Notes, DateOnly? NextVisitDate, DateTime? VisitedAt);

/// <summary>
/// Delivery runs. Stock leaves finished goods when the invoice is posted; at each stop the undelivered
/// quantity is returned to the warehouse through an automatic sales return. Therefore each packet is
/// counted exactly once as delivered, returned, or pending (stop still open).
/// </summary>
public class DeliveryService
{
    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;
    private readonly SalesService _sales;
    private readonly FinanceService _finance;

    public DeliveryService(AppDbContext db, PostingService post, ICurrentUser user, SalesService sales, FinanceService finance)
    { _db = db; _post = post; _user = user; _sales = sales; _finance = finance; }

    public async Task<PostResult> CreateAsync(DeliveryInput input)
    {
        _user.Require(Perm.DeliveryManage);
        var route = await _db.DeliveryRoutes.FirstOrDefaultAsync(r => r.Id == input.RouteId && r.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Route");
        if (!await _db.Users.AnyAsync(u => u.Id == input.AssignedUserId && u.BusinessId == _user.BusinessId && u.IsActive))
            throw AppException.NotFound("Assigned employee");
        var invoiceIds = input.InvoiceIds ?? new List<Guid>();
        var visits = input.VisitCustomerIds ?? new List<Guid>();
        if (invoiceIds.Count == 0 && visits.Count == 0) throw new AppException("empty", "Add at least one invoice or shop visit.");

        var invoices = await _db.SalesInvoices.Include(i => i.Lines)
            .Where(i => invoiceIds.Contains(i.Id) && i.BusinessId == _user.BusinessId).ToListAsync();
        if (invoices.Count != invoiceIds.Distinct().Count()) throw AppException.NotFound("One or more invoices");
        foreach (var inv in invoices)
        {
            if (inv.Status != "POSTED") throw new AppException("bad_invoice", $"Invoice {inv.InvoiceNo} is not posted.");
            if (await _db.DeliveryStops.AnyAsync(s => s.InvoiceId == inv.Id))
                throw new AppException("already_loaded", $"Invoice {inv.InvoiceNo} is already on a delivery.");
        }

        var d = new Delivery
        {
            BusinessId = _user.BusinessId, DeliveryNo = await _post.NextNumberAsync("DELIVERY", "DLV"), RouteId = route.Id,
            DeliveryDate = input.DeliveryDate, AssignedUserId = input.AssignedUserId, Vehicle = input.Vehicle, Notes = input.Notes, CreatedBy = _user.UserId
        };
        var seq = 0;
        foreach (var inv in invoices.OrderBy(i => i.InvoiceDate))
        {
            var open = await _db.SalesInvoices.Where(i => i.Id == inv.Id)
                .Select(i => i.Total - i.ReturnedAmount - (_db.CustomerReceiptAllocations.Where(a => a.InvoiceId == i.Id).Sum(a => (decimal?)a.Amount) ?? 0m))
                .FirstAsync();
            var stop = new DeliveryStop { DeliveryId = d.Id, Seq = ++seq, CustomerId = inv.CustomerId, InvoiceId = inv.Id, ExpectedCollection = Math.Max(open, 0) };
            foreach (var l in inv.Lines.Where(l => l.Quantity - l.ReturnedQty > 0))
                stop.Lines.Add(new DeliveryLine { StopId = stop.Id, InvoiceLineId = l.Id, VariationId = l.VariationId, LoadedQty = l.Quantity - l.ReturnedQty });
            d.Stops.Add(stop);
            inv.DeliveryStatus = "PENDING";
        }
        foreach (var cid in visits.Distinct())
        {
            if (!await _db.Customers.AnyAsync(c => c.Id == cid && c.BusinessId == _user.BusinessId)) throw AppException.NotFound("Customer");
            var bal = await _post.CustomerBalanceAsync(cid);
            d.Stops.Add(new DeliveryStop { DeliveryId = d.Id, Seq = ++seq, CustomerId = cid, ExpectedCollection = Math.Max(bal, 0) });
        }

        _db.Deliveries.Add(d);
        _post.Audit("CREATE", "Delivery", d.Id, $"Delivery {d.DeliveryNo} on {route.Name} with {d.Stops.Count} stops");
        await _db.SaveChangesAsync();
        return PostResult.Applied(d.Id, d.DeliveryNo);
    }

    public async Task StartAsync(Guid id)
    {
        var d = await Load(id);
        EnsureCanExecute(d);
        if (d.Status != "PLANNED") throw new AppException("bad_status", "This delivery has already started.");
        d.Status = "OUT"; d.UpdatedAt = DateTime.UtcNow;
        _post.Audit("START", "Delivery", d.Id, $"Delivery {d.DeliveryNo} left the warehouse");
        await _db.SaveChangesAsync();
    }

    public async Task<PostResult> UpdateStopAsync(StopUpdateInput input)
    {
        var stop = await _db.DeliveryStops.Include(s => s.Lines).FirstOrDefaultAsync(s => s.Id == input.StopId)
                   ?? throw AppException.NotFound("Delivery stop");
        var d = await Load(stop.DeliveryId);
        EnsureCanExecute(d);
        if (d.Status == "COMPLETED") throw new AppException("completed", "This delivery is already completed.");
        if (stop.Status != "PENDING") throw AppException.Conflict("This stop was already updated from another device.");

        var status = Methods.Upper(input.Status);
        if (status is not ("DELIVERED" or "PARTIAL" or "FAILED")) throw new AppException("bad_status", "Status must be DELIVERED, PARTIAL or FAILED.");
        if (status == "FAILED" && string.IsNullOrWhiteSpace(input.FailReason)) throw new AppException("reason_required", "Enter the reason the delivery failed.");
        var at = input.VisitedAt?.ToUniversalTime() ?? DateTime.UtcNow;

        foreach (var line in stop.Lines)
        {
            var delivered = status switch
            {
                "DELIVERED" => line.LoadedQty,
                "FAILED" => 0,
                _ => input.Lines?.FirstOrDefault(x => x.LineId == line.Id)?.DeliveredQty ?? 0
            };
            if (delivered < 0 || delivered > line.LoadedQty) throw new AppException("bad_quantity", "Delivered quantity must be between 0 and the loaded quantity.");
            line.DeliveredQty = delivered;
            line.ReturnedQty = line.LoadedQty - delivered;
        }

        var returned = stop.Lines.Where(l => l.ReturnedQty > 0).ToList();
        if (stop.InvoiceId.HasValue && returned.Count > 0)
        {
            var ret = await _sales.CreateReturnAsync(new ReturnInput(input.ReturnId ?? SalesService.DeterministicGuid(stop.Id, "return"), input.ReturnNo,
                stop.InvoiceId.Value, at, "CREDIT", null, status == "FAILED" ? $"Delivery failed: {input.FailReason}" : "Not delivered (partial delivery)",
                returned.Select(l => new ReturnLineInput(l.InvoiceLineId, l.ReturnedQty, "GOOD")).ToList()), "DELIVERY", internalCall: true);
            stop.ReturnId = ret.Id;
        }

        if (input.CollectedAmount > 0)
        {
            var rc = await _finance.PostReceiptAsync(new ReceiptInput(input.ReceiptId ?? SalesService.DeterministicGuid(stop.Id, "receipt"), input.ReceiptNo,
                stop.CustomerId, stop.InvoiceId, at, input.CollectedAmount, string.IsNullOrWhiteSpace(input.CollectionMethod) ? "CASH" : input.CollectionMethod!,
                null, $"Collected on {d.DeliveryNo}", null), internalCall: true);
            stop.ReceiptId = rc.Id;
            stop.CollectedAmount = Money.R2(input.CollectedAmount);
        }

        stop.Status = status;
        stop.FailReason = input.FailReason;
        stop.AcknowledgedBy = input.AcknowledgedBy;
        stop.Notes = input.Notes;
        stop.NextVisitDate = input.NextVisitDate;
        stop.VisitedAt = at;
        stop.Version++;
        if (stop.InvoiceId.HasValue)
        {
            var inv = await _db.SalesInvoices.FirstAsync(i => i.Id == stop.InvoiceId);
            inv.DeliveryStatus = status;
        }
        if (d.Status == "PLANNED") d.Status = "OUT";
        d.UpdatedAt = DateTime.UtcNow;
        _post.Audit("STOP", "Delivery", d.Id, $"{d.DeliveryNo} stop {stop.Seq}: {status}, collected {stop.CollectedAmount:0.00}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(stop.Id, d.DeliveryNo);
    }

    public async Task CompleteAsync(Guid id)
    {
        var d = await Load(id);
        EnsureCanExecute(d);
        var pending = d.Stops.Count(s => s.Status == "PENDING");
        if (pending > 0) throw new AppException("stops_pending", $"{pending} stop(s) are still pending. Mark each as delivered, partial or failed.");
        d.Status = "COMPLETED"; d.CompletedAt = DateTime.UtcNow; d.UpdatedAt = DateTime.UtcNow;
        _post.Audit("COMPLETE", "Delivery", d.Id, $"Delivery {d.DeliveryNo} completed");
        await _db.SaveChangesAsync();
    }

    private async Task<Delivery> Load(Guid id) =>
        await _db.Deliveries.Include(x => x.Stops).ThenInclude(s => s.Lines).FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
        ?? throw AppException.NotFound("Delivery");

    private void EnsureCanExecute(Delivery d)
    {
        if (_user.Has(Perm.DeliveryManage)) return;
        _user.Require(Perm.DeliveryExecute);
        if (d.AssignedUserId != _user.UserId) throw AppException.Forbidden("This delivery is assigned to another employee.");
    }
}
