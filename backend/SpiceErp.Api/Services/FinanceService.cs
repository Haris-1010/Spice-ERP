using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record ReceiptInput(Guid Id, string? ReceiptNo, Guid CustomerId, Guid? InvoiceId, DateTime ReceiptDate,
    decimal Amount, string Method, Guid? AccountId, string? Reference, string? Notes);

public record SupplierPaymentInput(Guid SupplierId, Guid? PurchaseId, DateTime PaymentDate, decimal Amount,
    string Method, Guid? AccountId, string? Reference, string? Notes);

public record ExpenseInput(Guid Id, string? ExpenseNo, DateTime ExpenseDate, string Category, decimal Amount,
    string? Method, Guid? AccountId, Guid? DeliveryId, string? Notes, string? AttachmentUrl);

public record CancelInput(string Reason);

/// <summary>Customer receipts, supplier payments and expenses. A receipt or payment is never revenue or expense.</summary>
public class FinanceService
{
    private static readonly string[] ExpenseCategories =
        { "TRANSPORT", "FUEL", "RENT", "SALARY", "ELECTRICITY", "PACKING_LABOUR", "MAINTENANCE", "MISC" };

    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;
    private readonly Numbering _numbers;

    public FinanceService(AppDbContext db, PostingService post, ICurrentUser user, Numbering numbers)
    { _db = db; _post = post; _user = user; _numbers = numbers; }

    // ------------------------------------------------------------ customer receipts
    public async Task<PostResult> PostReceiptAsync(ReceiptInput input, bool internalCall = false)
    {
        if (!internalCall) _user.Require(Perm.ReceiptsCreate);
        if (input.Id == Guid.Empty) throw new AppException("bad_id", "Receipt id is required.");

        var existing = await _db.CustomerReceipts.AsNoTracking().FirstOrDefaultAsync(r => r.Id == input.Id);
        if (existing != null) return PostResult.Duplicate(existing.Id, existing.ReceiptNo);

        if (input.Amount <= 0) throw new AppException("bad_amount", "Receipt amount must be greater than zero.");
        var method = Methods.Upper(input.Method);
        if (!Methods.Payment.Contains(method)) throw new AppException("bad_method", "Payment method must be CASH, BANK or WALLET.");

        var customer = await _db.Customers.FirstOrDefaultAsync(c => c.Id == input.CustomerId && c.BusinessId == _user.BusinessId)
                       ?? throw AppException.NotFound("Customer");
        if (input.InvoiceId.HasValue && !await _db.SalesInvoices.AnyAsync(i => i.Id == input.InvoiceId && i.CustomerId == customer.Id))
            throw new AppException("bad_invoice", "The invoice does not belong to this customer.");

        var account = await _post.AccountForAsync(method, input.AccountId);
        var number = await _numbers.ResolveAsync(input.ReceiptNo, "RC", "RECEIPT");
        var at = input.ReceiptDate == default ? DateTime.UtcNow : input.ReceiptDate.ToUniversalTime();

        var r = new CustomerReceipt
        {
            Id = input.Id, BusinessId = _user.BusinessId, ReceiptNo = number, CustomerId = customer.Id, InvoiceId = input.InvoiceId,
            ReceiptDate = at, Amount = Money.R2(input.Amount), Method = method, AccountId = account.Id,
            Reference = input.Reference, Notes = input.Notes, DeviceId = _user.DeviceId, CreatedBy = _user.UserId
        };
        _db.CustomerReceipts.Add(r);
        _post.CustomerEntry(customer.Id, "RECEIPT", 0, r.Amount, "CustomerReceipt", r.Id, at, $"Receipt {number}");
        _post.Cash(account.Id, r.Amount, "RECEIPT", r.Id, at, $"Receipt {number} — {customer.ShopName}");
        _post.Audit("CREATE", "CustomerReceipt", r.Id, $"Receipt {number} of {r.Amount:0.00} from {customer.ShopName}");
        await _db.SaveChangesAsync();
        await _post.ReallocateAsync(customer.Id);

        var balance = await _post.CustomerBalanceAsync(customer.Id);
        return PostResult.Applied(r.Id, number, null, new { balance });
    }

    public async Task CancelReceiptAsync(Guid id, string reason)
    {
        _user.Require(Perm.PaymentsManage);
        var r = await _db.CustomerReceipts.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
                ?? throw AppException.NotFound("Receipt");
        if (r.Status != "POSTED") throw new AppException("bad_status", "Only posted receipts can be cancelled.");
        if (string.IsNullOrWhiteSpace(reason)) throw new AppException("reason_required", "A cancellation reason is required.");
        var now = DateTime.UtcNow;
        r.Status = "CANCELLED";
        _post.CustomerEntry(r.CustomerId, "RECEIPT_CANCEL", r.Amount, 0, "CustomerReceipt", r.Id, now, $"Cancelled receipt {r.ReceiptNo}: {reason}");
        _post.Cash(r.AccountId, -r.Amount, "RECEIPT_CANCEL", r.Id, now, $"Cancelled receipt {r.ReceiptNo}");
        _db.CustomerReceiptAllocations.RemoveRange(_db.CustomerReceiptAllocations.Where(a => a.ReceiptId == r.Id));
        _post.Audit("CANCEL", "CustomerReceipt", r.Id, $"Receipt {r.ReceiptNo} cancelled: {reason}");
        await _db.SaveChangesAsync();
        await _post.ReallocateAsync(r.CustomerId);
    }

    // ------------------------------------------------------------ supplier payments
    public async Task<PostResult> PostSupplierPaymentAsync(SupplierPaymentInput input, bool internalCall = false)
    {
        if (!internalCall) _user.Require(Perm.PaymentsManage);
        if (input.Amount <= 0) throw new AppException("bad_amount", "Payment amount must be greater than zero.");
        var method = Methods.Upper(input.Method);
        if (!Methods.Payment.Contains(method)) throw new AppException("bad_method", "Payment method must be CASH, BANK or WALLET.");
        var supplier = await _db.Suppliers.FirstOrDefaultAsync(s => s.Id == input.SupplierId && s.BusinessId == _user.BusinessId)
                       ?? throw AppException.NotFound("Supplier");
        var account = await _post.AccountForAsync(method, input.AccountId);
        var number = await _post.NextNumberAsync("SUPPLIER_PAYMENT", "SP");
        var at = input.PaymentDate == default ? DateTime.UtcNow : input.PaymentDate.ToUniversalTime();

        var p = new SupplierPayment
        {
            BusinessId = _user.BusinessId, PaymentNo = number, SupplierId = supplier.Id, PurchaseId = input.PurchaseId,
            PaymentDate = at, Amount = Money.R2(input.Amount), Method = method, AccountId = account.Id,
            Reference = input.Reference, Notes = input.Notes, CreatedBy = _user.UserId
        };
        _db.SupplierPayments.Add(p);
        _post.SupplierEntry(supplier.Id, "PAYMENT", p.Amount, 0, "SupplierPayment", p.Id, at, $"Payment {number}");
        _post.Cash(account.Id, -p.Amount, "SUPPLIER_PAYMENT", p.Id, at, $"Payment {number} — {supplier.Name}");
        _post.Audit("CREATE", "SupplierPayment", p.Id, $"Payment {number} of {p.Amount:0.00} to {supplier.Name}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(p.Id, number);
    }

    public async Task CancelSupplierPaymentAsync(Guid id, string reason)
    {
        _user.Require(Perm.PaymentsManage);
        var p = await _db.SupplierPayments.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
                ?? throw AppException.NotFound("Supplier payment");
        if (p.Status != "POSTED") throw new AppException("bad_status", "Only posted payments can be cancelled.");
        if (string.IsNullOrWhiteSpace(reason)) throw new AppException("reason_required", "A cancellation reason is required.");
        var now = DateTime.UtcNow;
        p.Status = "CANCELLED";
        _post.SupplierEntry(p.SupplierId, "PAYMENT_CANCEL", 0, p.Amount, "SupplierPayment", p.Id, now, $"Cancelled payment {p.PaymentNo}: {reason}");
        _post.Cash(p.AccountId, p.Amount, "SUPPLIER_PAYMENT_CANCEL", p.Id, now, $"Cancelled payment {p.PaymentNo}");
        _post.Audit("CANCEL", "SupplierPayment", p.Id, $"Payment {p.PaymentNo} cancelled: {reason}");
        await _db.SaveChangesAsync();
    }

    // ------------------------------------------------------------ expenses
    public async Task<PostResult> PostExpenseAsync(ExpenseInput input)
    {
        _user.Require(Perm.ExpensesCreate);
        if (input.Id == Guid.Empty) throw new AppException("bad_id", "Expense id is required.");
        var existing = await _db.Expenses.AsNoTracking().FirstOrDefaultAsync(e => e.Id == input.Id);
        if (existing != null) return PostResult.Duplicate(existing.Id, existing.ExpenseNo);

        if (input.Amount <= 0) throw new AppException("bad_amount", "Expense amount must be greater than zero.");
        var category = Methods.Upper(input.Category);
        if (!ExpenseCategories.Contains(category)) throw new AppException("bad_category", "Unknown expense category.");
        var method = string.IsNullOrWhiteSpace(input.Method) ? "CASH" : Methods.Upper(input.Method);
        var account = await _post.AccountForAsync(method, input.AccountId);
        if (input.DeliveryId.HasValue && !await _db.Deliveries.AnyAsync(d => d.Id == input.DeliveryId && d.BusinessId == _user.BusinessId))
            throw AppException.NotFound("Delivery");

        var number = await _numbers.ResolveAsync(input.ExpenseNo, "EXP", "EXPENSE");
        var at = input.ExpenseDate == default ? DateTime.UtcNow : input.ExpenseDate.ToUniversalTime();
        var e = new Expense
        {
            Id = input.Id, BusinessId = _user.BusinessId, ExpenseNo = number, ExpenseDate = at, Category = category,
            Amount = Money.R2(input.Amount), AccountId = account.Id, DeliveryId = input.DeliveryId, Notes = input.Notes,
            AttachmentUrl = input.AttachmentUrl, DeviceId = _user.DeviceId, CreatedBy = _user.UserId
        };
        _db.Expenses.Add(e);
        _post.Cash(account.Id, -e.Amount, "EXPENSE", e.Id, at, $"Expense {number} — {category}");
        _post.Audit("CREATE", "Expense", e.Id, $"Expense {number} {category} {e.Amount:0.00}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(e.Id, number);
    }

    public async Task CancelExpenseAsync(Guid id, string reason)
    {
        _user.Require(Perm.PaymentsManage);
        var e = await _db.Expenses.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
                ?? throw AppException.NotFound("Expense");
        if (e.Status != "POSTED") throw new AppException("bad_status", "Only posted expenses can be cancelled.");
        if (string.IsNullOrWhiteSpace(reason)) throw new AppException("reason_required", "A cancellation reason is required.");
        e.Status = "CANCELLED";
        _post.Cash(e.AccountId, e.Amount, "EXPENSE_CANCEL", e.Id, DateTime.UtcNow, $"Cancelled expense {e.ExpenseNo}");
        _post.Audit("CANCEL", "Expense", e.Id, $"Expense {e.ExpenseNo} cancelled: {reason}");
        await _db.SaveChangesAsync();
    }
}
