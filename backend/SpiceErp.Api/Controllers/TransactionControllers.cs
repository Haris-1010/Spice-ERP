using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;
using SpiceErp.Api.Services;

namespace SpiceErp.Api.Controllers;

[ApiController, Route("api/purchases"), Authorize(Policy = Perm.PurchasesView)]
public class PurchasesController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly PurchaseService _svc; private readonly PostingService _post;
    public PurchasesController(AppDbContext db, ICurrentUser user, PurchaseService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(Guid? supplierId, DateOnly? from, DateOnly? to, string? q, int page = 1, int pageSize = 50)
    {
        pageSize = Math.Clamp(pageSize, 10, 200); page = Math.Max(1, page);
        var query = _db.Purchases.Where(p => p.BusinessId == _user.BusinessId);
        if (supplierId.HasValue) query = query.Where(p => p.SupplierId == supplierId);
        if (from.HasValue) query = query.Where(p => p.PurchaseDate >= from);
        if (to.HasValue) query = query.Where(p => p.PurchaseDate <= to);
        if (!string.IsNullOrWhiteSpace(q)) query = query.Where(p => p.PurchaseNo.Contains(q) || (p.SupplierInvoiceNo != null && p.SupplierInvoiceNo.Contains(q)));
        var total = await query.CountAsync();
        var items = await (from p in query join s in _db.Suppliers on p.SupplierId equals s.Id
                           orderby p.PurchaseDate descending, p.CreatedAt descending
                           select new { p.Id, p.PurchaseNo, p.PurchaseDate, p.SupplierInvoiceNo, supplier = s.Name, p.Status, p.SubTotal, p.TransportCost, p.DiscountAmount, p.TaxAmount, p.Total, p.AmountPaid })
            .Skip((page - 1) * pageSize).Take(pageSize).ToListAsync();
        return Ok(new { items, total, page, pageSize });
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id)
    {
        var p = await _db.Purchases.Include(x => x.Lines).FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Purchase");
        var supplier = await _db.Suppliers.FirstAsync(s => s.Id == p.SupplierId);
        var names = await _db.Products.Where(x => x.BusinessId == _user.BusinessId).ToDictionaryAsync(x => x.Id, x => x.Name);
        var mats = await _db.PackagingMaterials.Where(x => x.BusinessId == _user.BusinessId).ToDictionaryAsync(x => x.Id, x => x.Name);
        return Ok(new
        {
            purchase = p, supplier = new { supplier.Id, supplier.Name, supplier.Phone },
            lines = p.Lines.OrderBy(l => l.LineNo).Select(l => new { l.Id, l.LineType, l.Quantity, l.Rate, l.LineTotal, l.LandedCost, l.BatchNo, l.ExpiryDate,
                item = l.ProductId.HasValue ? names.GetValueOrDefault(l.ProductId.Value) : mats.GetValueOrDefault(l.MaterialId!.Value) })
        });
    }

    [HttpPost, Authorize(Policy = Perm.PurchasesManage)]
    public async Task<IActionResult> Create(PurchaseInput input) => Ok(await _post.InTransactionAsync(() => _svc.CreateAsync(input)));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.PurchasesManage)]
    public async Task<IActionResult> Cancel(Guid id, CancelInput input) { await _post.InTransactionAsync(async () => { await _svc.CancelAsync(id, input.Reason); return 0; }); return NoContent(); }

    [HttpGet("batches"), Authorize(Policy = Perm.InventoryView)]
    public async Task<IActionResult> Batches(Guid? productId, bool openOnly = true) => Ok(await (
        from b in _db.Batches
        where b.BusinessId == _user.BusinessId && (productId == null || b.ProductId == productId)
        let grams = _db.InventoryTransactions.Where(t => t.BatchId == b.Id && t.Bucket == "BULK").Sum(t => (long?)t.Quantity) ?? 0
        where !openOnly || grams > 0
        orderby b.ReceivedAt
        select new { b.Id, b.ProductId, b.BatchNo, b.ReceivedAt, b.ExpiryDate, b.ReceivedGrams, grams, costPerKg = b.UnitCostPerGram * 1000 }).ToListAsync());
}

[ApiController, Route("api/packing"), Authorize(Policy = Perm.InventoryView)]
public class PackingController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly PackingService _svc; private readonly PostingService _post;
    public PackingController(AppDbContext db, ICurrentUser user, PackingService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(string? status, int page = 1, int pageSize = 50)
    {
        pageSize = Math.Clamp(pageSize, 10, 200); page = Math.Max(1, page);
        var query = _db.PackingOrders.Where(o => o.BusinessId == _user.BusinessId && (status == null || o.Status == status));
        if (!_user.Has(Perm.PackingManage)) query = query.Where(o => o.AssignedToUserId == null || o.AssignedToUserId == _user.UserId);
        var total = await query.CountAsync();
        var showCost = _user.Has(Perm.ReportsFinancial) || _user.Has(Perm.PackingManage);
        var items = await (from o in query
                           join p in _db.Products on o.ProductId equals p.Id
                           join v in _db.ProductVariations on o.VariationId equals v.Id
                           join b in _db.Batches on o.BatchId equals b.Id
                           join u in _db.Users on o.AssignedToUserId equals (Guid?)u.Id into uj
                           from u in uj.DefaultIfEmpty()
                           orderby o.PackDate descending, o.CreatedAt descending
                           select new
                           {
                               o.Id, o.OrderNo, o.PackDate, o.Status, product = p.Name, productUr = p.NameUr, v.PacketGrams, b.BatchNo,
                               o.PlannedPackets, o.PlannedGrams, o.ProducedPackets, o.RejectedPackets, o.LossGrams, o.ConsumedGrams, o.PouchesUsed, o.LabelsUsed,
                               unitCost = showCost ? o.UnitCost : (decimal?)null, totalCost = showCost ? o.TotalCost : (decimal?)null,
                               assignedTo = u == null ? null : u.FullName, o.Notes, o.CancelReason, o.BatchId, o.VariationId
                           }).Skip((page - 1) * pageSize).Take(pageSize).ToListAsync();
        return Ok(new { items, total, page, pageSize });
    }

    [HttpPost, Authorize(Policy = Perm.PackingManage)]
    public async Task<IActionResult> Create(PackingOrderInput input) => Ok(await _post.InTransactionAsync(() => _svc.CreateAsync(input)));

    [HttpPost("{id:guid}/post"), Authorize(Policy = Perm.PackingPost)]
    public async Task<IActionResult> Post(Guid id, PackingPostInput input) => Ok(await _post.InTransactionAsync(() => _svc.PostAsync(id, input)));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.PackingManage)]
    public async Task<IActionResult> Cancel(Guid id, CancelInput input) { await _post.InTransactionAsync(async () => { await _svc.CancelAsync(id, input.Reason); return 0; }); return NoContent(); }
}

[ApiController, Route("api/inventory"), Authorize(Policy = Perm.InventoryView)]
public class InventoryController : ControllerBase
{
    private readonly InventoryService _svc; private readonly PostingService _post; private readonly Reports.ReportQueries _reports;
    public InventoryController(InventoryService svc, PostingService post, Reports.ReportQueries reports) { _svc = svc; _post = post; _reports = reports; }

    [HttpGet("stock")] public async Task<IActionResult> Stock() => Ok(await _reports.StockAsync());

    [HttpGet("ledger")]
    public async Task<IActionResult> Ledger(string bucket = "FINISHED", Guid? productId = null, Guid? variationId = null, Guid? batchId = null, Guid? materialId = null,
        DateOnly? from = null, DateOnly? to = null, int page = 1, int pageSize = 100)
        => Ok(await _reports.StockLedgerAsync(bucket, productId, variationId, batchId, materialId, from ?? DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-30)), to, page, pageSize));

    [HttpPost("adjustments"), Authorize(Policy = Perm.InventoryAdjust)]
    public async Task<IActionResult> Adjust(AdjustmentInput input) => Ok(await _post.InTransactionAsync(() => _svc.AdjustAsync(input)));

    [HttpPost("counts"), Authorize(Policy = Perm.InventoryAdjust)]
    public async Task<IActionResult> Count(StockCountInput input) => Ok(await _post.InTransactionAsync(() => _svc.CountAsync(input)));

    [HttpPost("damage"), Authorize(Policy = Perm.InventoryAdjust)]
    public async Task<IActionResult> Damage(DamageInput input) => Ok(await _post.InTransactionAsync(() => _svc.MarkDamagedAsync(input)));
}

[ApiController, Route("api/sales-invoices"), Authorize(Policy = Perm.SalesView)]
public class SalesInvoicesController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly SalesService _svc; private readonly PostingService _post;
    public SalesInvoicesController(AppDbContext db, ICurrentUser user, SalesService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(string? q, Guid? customerId, Guid? salespersonId, DateOnly? from, DateOnly? to, string? status, int page = 1, int pageSize = 50)
    {
        pageSize = Math.Clamp(pageSize, 10, 200); page = Math.Max(1, page);
        var query = _db.SalesInvoices.Where(i => i.BusinessId == _user.BusinessId);
        if (!_user.Has(Perm.SalesCancel) && !_user.Has(Perm.ReportsFinancial)) query = query.Where(i => i.SalespersonId == _user.UserId);
        if (customerId.HasValue) query = query.Where(i => i.CustomerId == customerId);
        if (salespersonId.HasValue) query = query.Where(i => i.SalespersonId == salespersonId);
        if (!string.IsNullOrWhiteSpace(status)) query = query.Where(i => i.Status == status);
        if (from.HasValue) { var f = from.Value.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc).AddHours(-5); query = query.Where(i => i.InvoiceDate >= f); }
        if (to.HasValue) { var t = to.Value.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc).AddHours(-5); query = query.Where(i => i.InvoiceDate < t); }
        if (!string.IsNullOrWhiteSpace(q)) query = query.Where(i => i.InvoiceNo.Contains(q) || _db.Customers.Any(c => c.Id == i.CustomerId && EF.Functions.ILike(c.ShopName, $"%{q}%")));
        var total = await query.CountAsync();
        var items = await (from i in query join c in _db.Customers on i.CustomerId equals c.Id
                           join u in _db.Users on i.SalespersonId equals (Guid?)u.Id into uj from u in uj.DefaultIfEmpty()
                           orderby i.InvoiceDate descending
                           select new { i.Id, i.InvoiceNo, i.InvoiceDate, customer = c.ShopName, customerId = c.Id, salesperson = u == null ? null : u.FullName,
                               i.Status, i.PaymentMethod, i.Total, i.AmountPaid, i.ReturnedAmount, i.DeliveryStatus })
            .Skip((page - 1) * pageSize).Take(pageSize).ToListAsync();
        return Ok(new { items, total, page, pageSize });
    }

    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id)
    {
        var i = await _db.SalesInvoices.Include(x => x.Lines).AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Invoice");
        var c = await _db.Customers.AsNoTracking().FirstAsync(x => x.Id == i.CustomerId);
        var sp = await _db.Users.Where(u => u.Id == i.SalespersonId).Select(u => u.FullName).FirstOrDefaultAsync();
        var open = await _db.SalesInvoices.Where(x => x.Id == id).Select(x => x.Total - x.ReturnedAmount - (_db.CustomerReceiptAllocations.Where(a => a.InvoiceId == x.Id).Sum(a => (decimal?)a.Amount) ?? 0)).FirstAsync();
        i.Lines = i.Lines.OrderBy(l => l.LineNo).ToList();
        if (!_user.Has(Perm.ReportsFinancial)) { i.CostTotal = 0; foreach (var l in i.Lines) l.UnitCost = 0; }
        return Ok(new { invoice = i, customer = new { c.Id, c.Code, c.ShopName, c.Phone, c.Address, c.Area, c.City }, salesperson = sp, openAmount = i.Status == "POSTED" ? open : 0 });
    }

    [HttpPost, Authorize(Policy = Perm.SalesCreate)]
    public async Task<IActionResult> Create(InvoiceInput input) => Ok(await _post.InTransactionAsync(() => _svc.PostInvoiceAsync(input)));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.SalesCancel)]
    public async Task<IActionResult> Cancel(Guid id, CancelInput input) { await _post.InTransactionAsync(async () => { await _svc.CancelInvoiceAsync(id, input.Reason); return 0; }); return NoContent(); }
}

public record SalesOrderInput(Guid Id, Guid CustomerId, DateTime OrderDate, string? Notes, List<SalesOrderLineInput> Lines);
public record SalesOrderLineInput(Guid VariationId, int Quantity, decimal UnitPrice);

[ApiController, Route("api/sales-orders"), Authorize(Policy = Perm.SalesView)]
public class SalesOrdersController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly PostingService _post;
    public SalesOrdersController(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(string? status = "OPEN") => Ok(await (
        from o in _db.SalesOrders where o.BusinessId == _user.BusinessId && (status == null || o.Status == status)
        join c in _db.Customers on o.CustomerId equals c.Id
        orderby o.OrderDate descending
        select new { o.Id, o.OrderNo, o.OrderDate, o.Status, o.CustomerId, customer = c.ShopName, o.Notes, o.InvoiceId,
            lines = o.Lines.Select(l => new { l.VariationId, l.Quantity, l.UnitPrice }) }).Take(200).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.SalesCreate)]
    public async Task<IActionResult> Create(SalesOrderInput input) => Ok(await _post.InTransactionAsync(async () =>
    {
        if (input.Id == Guid.Empty) throw new AppException("bad_id", "Order id is required.");
        var existing = await _db.SalesOrders.FirstOrDefaultAsync(o => o.Id == input.Id);
        if (existing != null) return PostResult.Duplicate(existing.Id, existing.OrderNo);
        if (input.Lines == null || input.Lines.Count == 0 || input.Lines.Any(l => l.Quantity <= 0)) throw new AppException("no_lines", "Add at least one item with a positive quantity.");
        if (!await _db.Customers.AnyAsync(c => c.Id == input.CustomerId && c.BusinessId == _user.BusinessId)) throw AppException.NotFound("Customer");
        var o = new SalesOrder
        {
            Id = input.Id, BusinessId = _user.BusinessId, OrderNo = await _post.NextNumberAsync("SALES_ORDER", "SO"), CustomerId = input.CustomerId,
            SalespersonId = _user.UserId, OrderDate = input.OrderDate == default ? DateTime.UtcNow : input.OrderDate.ToUniversalTime(),
            Notes = input.Notes, DeviceId = _user.DeviceId, CreatedBy = _user.UserId
        };
        foreach (var l in input.Lines) o.Lines.Add(new SalesOrderLine { OrderId = o.Id, VariationId = l.VariationId, Quantity = l.Quantity, UnitPrice = l.UnitPrice });
        _db.SalesOrders.Add(o);
        _post.Audit("CREATE", "SalesOrder", o.Id, $"Sales order {o.OrderNo}");
        return PostResult.Applied(o.Id, o.OrderNo);
    }));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.SalesCreate)]
    public async Task<IActionResult> Cancel(Guid id)
    {
        var o = await _db.SalesOrders.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Order");
        if (o.Status != "OPEN") throw new AppException("bad_status", "Only open orders can be cancelled.");
        o.Status = "CANCELLED";
        _post.Audit("CANCEL", "SalesOrder", o.Id, $"Sales order {o.OrderNo} cancelled");
        await _db.SaveChangesAsync();
        return NoContent();
    }
}

[ApiController, Route("api/sales-returns"), Authorize(Policy = Perm.SalesView)]
public class SalesReturnsController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly SalesService _svc; private readonly PostingService _post;
    public SalesReturnsController(AppDbContext db, ICurrentUser user, SalesService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(DateOnly? from, DateOnly? to) => Ok(await (
        from r in _db.SalesReturns where r.BusinessId == _user.BusinessId
        join c in _db.Customers on r.CustomerId equals c.Id
        join i in _db.SalesInvoices on r.InvoiceId equals i.Id
        orderby r.ReturnDate descending
        select new { r.Id, r.ReturnNo, r.ReturnDate, r.Origin, r.Settlement, r.Reason, r.Total, customer = c.ShopName, invoiceNo = i.InvoiceNo,
            lines = r.Lines.Select(l => new { l.VariationId, l.Quantity, l.Condition, l.Restock, l.LineTotal }) }).Take(300).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.ReturnsCreate)]
    public async Task<IActionResult> Create(ReturnInput input) => Ok(await _post.InTransactionAsync(() => _svc.CreateReturnAsync(input)));
}

[ApiController, Route("api/customer-receipts"), Authorize(Policy = Perm.SalesView)]
public class ReceiptsController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly FinanceService _svc; private readonly PostingService _post;
    public ReceiptsController(AppDbContext db, ICurrentUser user, FinanceService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(Guid? customerId, DateOnly? from, DateOnly? to) => Ok(await (
        from r in _db.CustomerReceipts where r.BusinessId == _user.BusinessId && (customerId == null || r.CustomerId == customerId)
        join c in _db.Customers on r.CustomerId equals c.Id
        join a in _db.CashAccounts on r.AccountId equals a.Id
        orderby r.ReceiptDate descending
        select new { r.Id, r.ReceiptNo, r.ReceiptDate, r.Amount, r.Method, account = a.Name, r.Status, r.Reference, customer = c.ShopName, customerId = c.Id }).Take(300).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.ReceiptsCreate)]
    public async Task<IActionResult> Create(ReceiptInput input) => Ok(await _post.InTransactionAsync(() => _svc.PostReceiptAsync(input)));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.PaymentsManage)]
    public async Task<IActionResult> Cancel(Guid id, CancelInput input) { await _post.InTransactionAsync(async () => { await _svc.CancelReceiptAsync(id, input.Reason); return 0; }); return NoContent(); }
}

[ApiController, Route("api/supplier-payments"), Authorize(Policy = Perm.SuppliersView)]
public class SupplierPaymentsController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly FinanceService _svc; private readonly PostingService _post;
    public SupplierPaymentsController(AppDbContext db, ICurrentUser user, FinanceService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(Guid? supplierId) => Ok(await (
        from p in _db.SupplierPayments where p.BusinessId == _user.BusinessId && (supplierId == null || p.SupplierId == supplierId)
        join s in _db.Suppliers on p.SupplierId equals s.Id
        join a in _db.CashAccounts on p.AccountId equals a.Id
        orderby p.PaymentDate descending
        select new { p.Id, p.PaymentNo, p.PaymentDate, p.Amount, p.Method, account = a.Name, p.Status, p.Reference, supplier = s.Name }).Take(300).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.PaymentsManage)]
    public async Task<IActionResult> Create(SupplierPaymentInput input) => Ok(await _post.InTransactionAsync(() => _svc.PostSupplierPaymentAsync(input)));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.PaymentsManage)]
    public async Task<IActionResult> Cancel(Guid id, CancelInput input) { await _post.InTransactionAsync(async () => { await _svc.CancelSupplierPaymentAsync(id, input.Reason); return 0; }); return NoContent(); }
}

[ApiController, Route("api/expenses"), Authorize]
public class ExpensesController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly FinanceService _svc; private readonly PostingService _post;
    public ExpensesController(AppDbContext db, ICurrentUser user, FinanceService svc, PostingService post) { _db = db; _user = user; _svc = svc; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(DateOnly? from, DateOnly? to, string? category)
    {
        var all = _user.Has(Perm.ReportsFinancial);
        return Ok(await (
            from e in _db.Expenses where e.BusinessId == _user.BusinessId && (all || e.CreatedBy == _user.UserId) && (category == null || e.Category == category)
            join a in _db.CashAccounts on e.AccountId equals a.Id
            join u in _db.Users on e.CreatedBy equals u.Id
            orderby e.ExpenseDate descending
            select new { e.Id, e.ExpenseNo, e.ExpenseDate, e.Category, e.Amount, account = a.Name, e.Notes, e.AttachmentUrl, e.Status, e.DeliveryId, createdBy = u.FullName }).Take(500).ToListAsync());
    }

    [HttpPost, Authorize(Policy = Perm.ExpensesCreate)]
    public async Task<IActionResult> Create(ExpenseInput input) => Ok(await _post.InTransactionAsync(() => _svc.PostExpenseAsync(input)));

    [HttpPost("{id:guid}/cancel"), Authorize(Policy = Perm.PaymentsManage)]
    public async Task<IActionResult> Cancel(Guid id, CancelInput input) { await _post.InTransactionAsync(async () => { await _svc.CancelExpenseAsync(id, input.Reason); return 0; }); return NoContent(); }
}

[ApiController, Route("api/deliveries"), Authorize]
public class DeliveriesController : ControllerBase
{
    private readonly AppDbContext _db; private readonly ICurrentUser _user; private readonly DeliveryService _svc; private readonly PostingService _post; private readonly Reports.ReportQueries _reports;
    public DeliveriesController(AppDbContext db, ICurrentUser user, DeliveryService svc, PostingService post, Reports.ReportQueries reports) { _db = db; _user = user; _svc = svc; _post = post; _reports = reports; }

    [HttpGet]
    public async Task<IActionResult> List(DateOnly? from, DateOnly? to)
    {
        if (!_user.Has(Perm.DeliveryManage)) _user.Require(Perm.DeliveryExecute);
        var all = _user.Has(Perm.DeliveryManage);
        var f = from ?? DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-14));
        return Ok(await (
            from d in _db.Deliveries where d.BusinessId == _user.BusinessId && (all || d.AssignedUserId == _user.UserId) && (d.DeliveryDate >= f || d.Status != "COMPLETED") && (to == null || d.DeliveryDate <= to)
            join r in _db.DeliveryRoutes on d.RouteId equals r.Id
            join u in _db.Users on d.AssignedUserId equals u.Id
            orderby d.DeliveryDate descending
            select new { d.Id, d.DeliveryNo, d.DeliveryDate, d.Status, d.Vehicle, route = r.Name, assignedTo = u.FullName, d.AssignedUserId,
                stops = d.Stops.Count, pending = d.Stops.Count(s => s.Status == "PENDING") }).ToListAsync());
    }

    /// <summary>Delivery sheet: everything needed before departure and at each shop.</summary>
    [HttpGet("{id:guid}")]
    public async Task<IActionResult> Get(Guid id)
    {
        var d = await _db.Deliveries.Include(x => x.Stops).ThenInclude(s => s.Lines).AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Delivery");
        if (!_user.Has(Perm.DeliveryManage) && d.AssignedUserId != _user.UserId) throw AppException.Forbidden();
        var route = await _db.DeliveryRoutes.FirstAsync(r => r.Id == d.RouteId);
        var user = await _db.Users.Where(u => u.Id == d.AssignedUserId).Select(u => u.FullName).FirstAsync();
        var custIds = d.Stops.Select(s => s.CustomerId).ToList();
        var customers = await _db.Customers.Where(c => custIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id);
        var balances = await _db.CustomerLedgerEntries.Where(e => custIds.Contains(e.CustomerId)).GroupBy(e => e.CustomerId).Select(g => new { g.Key, b = g.Sum(e => e.Debit - e.Credit) }).ToDictionaryAsync(x => x.Key, x => x.b);
        var invIds = d.Stops.Where(s => s.InvoiceId.HasValue).Select(s => s.InvoiceId!.Value).ToList();
        var invoices = await _db.SalesInvoices.Include(i => i.Lines).Where(i => invIds.Contains(i.Id)).ToDictionaryAsync(i => i.Id);
        return Ok(new
        {
            d.Id, d.DeliveryNo, d.DeliveryDate, d.Status, d.Vehicle, d.Notes, route = route.Name, assignedTo = user, d.AssignedUserId,
            stops = d.Stops.OrderBy(s => s.Seq).Select(s =>
            {
                var c = customers[s.CustomerId];
                var inv = s.InvoiceId.HasValue ? invoices[s.InvoiceId.Value] : null;
                return new
                {
                    s.Id, s.Seq, s.Status, s.FailReason, s.ExpectedCollection, s.CollectedAmount, s.AcknowledgedBy, s.Notes, s.NextVisitDate, s.VisitedAt, s.Version,
                    customer = new { c.Id, c.ShopName, c.Address, c.Area, c.Phone }, outstanding = balances.GetValueOrDefault(c.Id),
                    invoice = inv == null ? null : new { inv.Id, inv.InvoiceNo, inv.Total },
                    lines = s.Lines.Select(l =>
                    {
                        var il = inv?.Lines.FirstOrDefault(x => x.Id == l.InvoiceLineId);
                        return new { l.Id, l.InvoiceLineId, l.VariationId, description = il?.Description, descriptionUr = il?.DescriptionUr, l.LoadedQty, l.DeliveredQty, l.ReturnedQty };
                    })
                };
            })
        });
    }

    [HttpGet("{id:guid}/reconciliation")]
    public async Task<IActionResult> Reconciliation(Guid id) => Ok(await _reports.DeliveryReconciliationAsync(id));

    [HttpPost, Authorize(Policy = Perm.DeliveryManage)]
    public async Task<IActionResult> Create(DeliveryInput input) => Ok(await _post.InTransactionAsync(() => _svc.CreateAsync(input)));

    [HttpPost("{id:guid}/start")]
    public async Task<IActionResult> Start(Guid id) { await _post.InTransactionAsync(async () => { await _svc.StartAsync(id); return 0; }); return NoContent(); }

    [HttpPost("stops")]
    public async Task<IActionResult> UpdateStop(StopUpdateInput input) => Ok(await _post.InTransactionAsync(() => _svc.UpdateStopAsync(input)));

    [HttpPost("{id:guid}/complete")]
    public async Task<IActionResult> Complete(Guid id) { await _post.InTransactionAsync(async () => { await _svc.CompleteAsync(id); return 0; }); return NoContent(); }
}

[ApiController, Route("api/reports"), Authorize(Policy = Perm.ReportsView)]
public class ReportsController : ControllerBase
{
    private readonly Reports.ReportQueries _q; private readonly ICurrentUser _user;
    public ReportsController(Reports.ReportQueries q, ICurrentUser user) { _q = q; _user = user; }

    [HttpGet("dashboard")]
    public async Task<IActionResult> Dashboard(DateOnly? from, DateOnly? to) => Ok(await _q.DashboardAsync(from, to));

    [HttpGet("sales")]
    public async Task<IActionResult> Sales(string groupBy = "product", DateOnly? from = null, DateOnly? to = null) => Ok(await _q.SalesSummaryAsync(groupBy, from, to));

    [HttpGet("purchases")]
    public async Task<IActionResult> Purchases(string groupBy = "supplier", DateOnly? from = null, DateOnly? to = null) => Ok(await _q.PurchasesSummaryAsync(groupBy, from, to));

    [HttpGet("price-history/{productId:guid}")]
    public async Task<IActionResult> PriceHistory(Guid productId) => Ok(await _q.PriceHistoryAsync(productId));

    [HttpGet("packing")]
    public async Task<IActionResult> Packing(DateOnly? from, DateOnly? to) => Ok(await _q.PackingReportAsync(from, to));

    [HttpGet("deliveries")]
    public async Task<IActionResult> Deliveries(DateOnly? from, DateOnly? to) => Ok(await _q.DeliveryReportAsync(from, to));

    [HttpGet("profit-loss"), Authorize(Policy = Perm.ReportsFinancial)]
    public async Task<IActionResult> ProfitLoss(DateOnly? from, DateOnly? to) => Ok(await _q.ProfitAndLossAsync(from, to));

    [HttpGet("aging"), Authorize(Policy = Perm.ReportsFinancial)]
    public async Task<IActionResult> Aging() => Ok(await _q.AgingAsync());

    [HttpGet("cash-book"), Authorize(Policy = Perm.ReportsFinancial)]
    public async Task<IActionResult> CashBook(Guid? accountId, DateOnly? from, DateOnly? to) => Ok(await _q.CashBookAsync(accountId, from, to));

    [HttpGet("expenses"), Authorize(Policy = Perm.ReportsFinancial)]
    public async Task<IActionResult> Expenses(DateOnly? from, DateOnly? to) => Ok(await _q.ExpenseSummaryAsync(from, to));

    [HttpGet("customer-statement/{id:guid}"), Authorize(Policy = Perm.CustomersView)]
    public async Task<IActionResult> CustomerStatement(Guid id, DateOnly? from, DateOnly? to) =>
        Ok(await _q.CustomerStatementAsync(id, from ?? DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-90)), to));

    [HttpGet("supplier-statement/{id:guid}"), Authorize(Policy = Perm.SuppliersView)]
    public async Task<IActionResult> SupplierStatement(Guid id, DateOnly? from, DateOnly? to) =>
        Ok(await _q.SupplierStatementAsync(id, from ?? DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-90)), to));
}

[ApiController, Route("api/sync"), Authorize]
public class SyncController : ControllerBase
{
    private readonly SyncService _svc; private readonly AppDbContext _db; private readonly ICurrentUser _user;
    public SyncController(SyncService svc, AppDbContext db, ICurrentUser user) { _svc = svc; _db = db; _user = user; }

    [HttpPost("push")]
    public async Task<IActionResult> Push(SyncPushRequest req) => Ok(await _svc.PushAsync(req));

    [HttpGet("pull")]
    public async Task<IActionResult> Pull(Guid deviceId, DateTime? since) => Ok(await _svc.PullAsync(deviceId, since));

    [HttpGet("status")]
    public async Task<IActionResult> Status()
    {
        var d = _user.DeviceId.HasValue ? await _db.Devices.FirstOrDefaultAsync(x => x.Id == _user.DeviceId) : null;
        return Ok(new { serverTime = DateTime.UtcNow, device = d == null ? null : new { d.Id, d.Prefix, d.Name, d.IsRevoked, d.LastPushAt, d.LastPullAt } });
    }

    [HttpGet("conflicts"), Authorize(Policy = Perm.SyncReview)]
    public async Task<IActionResult> Conflicts(string status = "OPEN") => Ok(await (
        from c in _db.SyncConflicts where c.BusinessId == _user.BusinessId && c.Status == status
        join d in _db.Devices on c.DeviceId equals (Guid?)d.Id into dj from d in dj.DefaultIfEmpty()
        orderby c.CreatedAt descending
        select new { c.Id, c.ConflictType, c.EntityType, c.EntityId, c.Details, c.Status, c.CreatedAt, device = d == null ? null : d.Prefix, c.ResolutionNote }).Take(500).ToListAsync());

    public record ResolveInput(string Note);

    [HttpPost("conflicts/{id:guid}/resolve"), Authorize(Policy = Perm.SyncReview)]
    public async Task<IActionResult> Resolve(Guid id, ResolveInput input)
    {
        var c = await _db.SyncConflicts.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Conflict");
        if (string.IsNullOrWhiteSpace(input.Note)) throw new AppException("note_required", "Describe how the conflict was resolved.");
        c.Status = "RESOLVED"; c.ResolvedAt = DateTime.UtcNow; c.ResolvedBy = _user.UserId; c.ResolutionNote = input.Note;
        _db.AuditLogs.Add(new AuditLog { BusinessId = _user.BusinessId, UserId = _user.UserId, DeviceId = _user.DeviceId, Action = "RESOLVE", EntityType = "SyncConflict", EntityId = id.ToString(), Summary = $"{c.ConflictType} resolved: {input.Note}" });
        await _db.SaveChangesAsync();
        return NoContent();
    }
}
