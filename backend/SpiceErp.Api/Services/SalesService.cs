using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record InvoiceLineInput(Guid Id, Guid VariationId, int Quantity, decimal UnitPrice, decimal DiscountAmount);

public record InvoiceInput(Guid Id, string? InvoiceNo, DateTime InvoiceDate, Guid CustomerId, Guid? SalesOrderId,
    string PaymentMethod, decimal AmountPaid, Guid? PaymentAccountId, Guid? PaymentReceiptId,
    bool RequiresDelivery, string? Notes, List<InvoiceLineInput> Lines);

public record ReturnLineInput(Guid InvoiceLineId, int Quantity, string Condition);

public record ReturnInput(Guid Id, string? ReturnNo, Guid InvoiceId, DateTime ReturnDate, string Settlement,
    Guid? RefundAccountId, string? Reason, List<ReturnLineInput> Lines);

/// <summary>Invoices, cancellations (controlled reversal) and sales returns.</summary>
public class SalesService
{
    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;
    private readonly Numbering _numbers;
    private readonly FinanceService _finance;

    public SalesService(AppDbContext db, PostingService post, ICurrentUser user, Numbering numbers, FinanceService finance)
    { _db = db; _post = post; _user = user; _numbers = numbers; _finance = finance; }

    public static decimal ListPriceFor(ProductVariation v, string customerType) => customerType switch
    {
        "WHOLESALER" => v.WholesalePrice,
        "DISTRIBUTOR" => v.DealerPrice ?? v.WholesalePrice,
        _ => v.RetailPrice
    };

    /// <summary>
    /// Posts an invoice. Invoices come from devices (online or offline) with a device-generated UUID,
    /// so posting is idempotent by Id. The server recomputes every amount from the lines and
    /// returns the authoritative values; problems that cannot be undone in the shop (selling stock
    /// the server does not have, prices below minimum) are posted and flagged for owner review
    /// instead of silently discarding a real sale.
    /// </summary>
    public async Task<PostResult> PostInvoiceAsync(InvoiceInput input, Guid? opKey = null)
    {
        _user.Require(Perm.SalesCreate);
        if (input.Id == Guid.Empty) throw new AppException("bad_id", "Invoice id is required.");

        var existing = await _db.SalesInvoices.AsNoTracking().FirstOrDefaultAsync(i => i.Id == input.Id);
        if (existing != null)
        {
            if (existing.BusinessId != _user.BusinessId) throw AppException.Forbidden();
            return PostResult.Duplicate(existing.Id, existing.InvoiceNo, InvoiceData(existing));
        }

        if (input.Lines == null || input.Lines.Count == 0) throw new AppException("no_lines", "An invoice needs at least one item.");
        if (input.Lines.Count > 300) throw new AppException("too_many_lines", "An invoice can have at most 300 items.");
        foreach (var l in input.Lines)
        {
            if (l.Id == Guid.Empty) throw new AppException("bad_id", "Every invoice line needs an id.");
            if (l.Quantity <= 0) throw new AppException("bad_quantity", "Quantities must be greater than zero.");
            if (l.UnitPrice < 0 || l.DiscountAmount < 0) throw new AppException("bad_price", "Prices and discounts cannot be negative.");
        }
        var method = Methods.Upper(input.PaymentMethod);
        if (!Methods.InvoicePayment.Contains(method)) throw new AppException("bad_method", "Unknown payment method.");
        if (input.AmountPaid < 0) throw new AppException("bad_amount", "Amount paid cannot be negative.");

        var number = await _numbers.ResolveAsync(input.InvoiceNo, "INV", "INVOICE");
        if (await _db.SalesInvoices.AnyAsync(i => i.BusinessId == _user.BusinessId && i.InvoiceNo == number))
            throw AppException.Conflict($"Invoice number {number} is already used by another invoice.");

        var variationIds = input.Lines.Select(l => l.VariationId).Distinct().ToList();
        await _post.LockAsync("Customers", new[] { input.CustomerId });
        await _post.LockAsync("ProductVariations", variationIds);

        var customer = await _db.Customers.FirstOrDefaultAsync(c => c.Id == input.CustomerId && c.BusinessId == _user.BusinessId)
                       ?? throw AppException.NotFound("Customer");
        var variations = await _db.ProductVariations.Where(v => variationIds.Contains(v.Id) && v.BusinessId == _user.BusinessId).ToListAsync();
        if (variations.Count != variationIds.Count) throw AppException.NotFound("One or more products");
        var productIds = variations.Select(v => v.ProductId).Distinct().ToList();
        var products = await _db.Products.Where(p => productIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id);
        var vmap = variations.ToDictionary(v => v.Id);
        var business = await _post.BusinessAsync();

        var warnings = new List<string>();
        var canDiscount = _user.Has(Perm.SalesDiscount);
        var at = input.InvoiceDate == default ? DateTime.UtcNow : input.InvoiceDate.ToUniversalTime();

        var inv = new SalesInvoice
        {
            Id = input.Id, BusinessId = _user.BusinessId, InvoiceNo = number, DeviceId = _user.DeviceId, InvoiceDate = at,
            CustomerId = customer.Id, SalespersonId = _user.UserId, SalesOrderId = input.SalesOrderId, PaymentMethod = method,
            DeliveryStatus = input.RequiresDelivery ? "PENDING" : "NOT_REQUIRED", Notes = input.Notes,
            CreatedBy = _user.UserId, CreatedAt = at, ReceivedAt = DateTime.UtcNow
        };

        var lineNo = 0;
        foreach (var l in input.Lines)
        {
            var v = vmap[l.VariationId];
            var p = products[v.ProductId];
            var list = ListPriceFor(v, customer.CustomerType);
            var gross = Money.R2(l.Quantity * l.UnitPrice);
            var disc = Math.Min(Money.R2(l.DiscountAmount), gross);
            var taxable = gross - disc;
            var tax = Money.R2(taxable * p.TaxRate / 100m);
            var label = $"{p.Name} {v.PacketGrams} g";

            if (!v.IsActive || !p.IsActive) warnings.Add($"{label} is inactive on the server.");
            if (v.MinPrice.HasValue && l.UnitPrice < v.MinPrice.Value && !canDiscount)
            {
                warnings.Add($"{label}: price {l.UnitPrice:0.00} is below the minimum {v.MinPrice:0.00}.");
                _post.Conflict("PRICE_BELOW_MINIMUM", "SalesInvoice", inv.Id, $"{number}: {label} sold at {l.UnitPrice:0.00}, minimum {v.MinPrice:0.00}.", opKey);
            }
            else if ((l.UnitPrice < list || disc > 0) && !canDiscount)
            {
                warnings.Add($"{label}: price/discount differs from the current list price {list:0.00}.");
                _post.Conflict("STALE_PRICE", "SalesInvoice", inv.Id, $"{number}: {label} at {l.UnitPrice:0.00} (discount {disc:0.00}); list price is {list:0.00}.", opKey);
            }

            inv.Lines.Add(new SalesInvoiceLine
            {
                Id = l.Id, InvoiceId = inv.Id, LineNo = ++lineNo, ProductId = p.Id, VariationId = v.Id,
                Description = label, DescriptionUr = string.IsNullOrWhiteSpace(p.NameUr) ? null : $"{p.NameUr} {v.PacketGrams} گرام",
                PacketGrams = v.PacketGrams, Quantity = l.Quantity, ListPrice = list, UnitPrice = Money.R2(l.UnitPrice),
                DiscountAmount = disc, TaxRate = p.TaxRate, TaxAmount = tax, LineTotal = taxable + tax, UnitCost = v.AvgUnitCost
            });
        }

        // Stock check per variation (server-authoritative balance from the ledger).
        foreach (var g in inv.Lines.GroupBy(x => x.VariationId))
        {
            var onHand = await _post.FinishedPacketsAsync(g.Key);
            var need = g.Sum(x => x.Quantity);
            if (onHand < need && !business.AllowNegativeStock)
            {
                var label = g.First().Description;
                warnings.Add($"{label}: sold {need}, server stock was {onHand}.");
                _post.Conflict("OVERSELL", "SalesInvoice", inv.Id, $"{number}: {label} sold {need} packets but only {onHand} were in stock.", opKey);
            }
        }

        inv.SubTotal = inv.Lines.Sum(x => Money.R2(x.Quantity * x.UnitPrice));
        inv.DiscountAmount = inv.Lines.Sum(x => x.DiscountAmount);
        inv.TaxAmount = inv.Lines.Sum(x => x.TaxAmount);
        inv.Total = inv.Lines.Sum(x => x.LineTotal);
        inv.CostTotal = Money.R2(inv.Lines.Sum(x => x.Quantity * x.UnitCost));
        inv.PreviousBalance = await _post.CustomerBalanceAsync(customer.Id);
        inv.AmountPaid = Money.R2(input.AmountPaid);
        inv.BalanceAfter = inv.PreviousBalance + inv.Total - inv.AmountPaid;

        _db.SalesInvoices.Add(inv);
        foreach (var line in inv.Lines)
            _post.FinishedOut(vmap[line.VariationId], line.Quantity, "SALE", "SalesInvoice", inv.Id, at);
        _post.CustomerEntry(customer.Id, "INVOICE", inv.Total, 0, "SalesInvoice", inv.Id, at, $"Invoice {number}");

        if (customer.CreditLimit > 0 && inv.BalanceAfter > customer.CreditLimit)
        {
            warnings.Add($"Credit limit {customer.CreditLimit:0.00} exceeded (balance {inv.BalanceAfter:0.00}).");
            _post.Conflict("CREDIT_LIMIT", "SalesInvoice", inv.Id, $"{number}: {customer.ShopName} balance {inv.BalanceAfter:0.00} exceeds limit {customer.CreditLimit:0.00}.", opKey);
        }

        if (input.SalesOrderId.HasValue)
        {
            var so = await _db.SalesOrders.FirstOrDefaultAsync(o => o.Id == input.SalesOrderId && o.BusinessId == _user.BusinessId);
            if (so != null) { so.Status = "INVOICED"; so.InvoiceId = inv.Id; }
        }

        _post.Audit("CREATE", "SalesInvoice", inv.Id, $"Invoice {number} for {customer.ShopName}, total {inv.Total:0.00}");
        await _db.SaveChangesAsync();

        if (inv.AmountPaid > 0)
        {
            var receiptMethod = method == "CREDIT" ? "CASH" : method;
            await _finance.PostReceiptAsync(new ReceiptInput(
                input.PaymentReceiptId ?? DeterministicGuid(inv.Id, "payment"), null, customer.Id, inv.Id, at,
                inv.AmountPaid, receiptMethod, input.PaymentAccountId, $"Paid on {number}", null), internalCall: true);
        }
        else
        {
            await _post.ReallocateAsync(customer.Id);
        }

        return PostResult.Applied(inv.Id, number, warnings, InvoiceData(inv));
    }

    private static object InvoiceData(SalesInvoice i) => new
    {
        invoiceNo = i.InvoiceNo, subTotal = i.SubTotal, discountAmount = i.DiscountAmount, taxAmount = i.TaxAmount,
        total = i.Total, previousBalance = i.PreviousBalance, amountPaid = i.AmountPaid, balanceAfter = i.BalanceAfter
    };

    /// <summary>Stable UUID derived from another id, so a retried invoice never creates a second payment.</summary>
    public static Guid DeterministicGuid(Guid seed, string salt)
    {
        var bytes = seed.ToByteArray();
        var hash = System.Security.Cryptography.SHA256.HashData(bytes.Concat(System.Text.Encoding.UTF8.GetBytes(salt)).ToArray());
        var g = new byte[16];
        Array.Copy(hash, g, 16);
        g[7] = (byte)((g[7] & 0x0F) | 0x50); // version 5-style marker
        g[8] = (byte)((g[8] & 0x3F) | 0x80);
        return new Guid(g);
    }

    /// <summary>Cancels a posted invoice through reversal entries. Not allowed once goods were returned or delivered.</summary>
    public async Task CancelInvoiceAsync(Guid id, string reason)
    {
        _user.Require(Perm.SalesCancel);
        if (string.IsNullOrWhiteSpace(reason)) throw new AppException("reason_required", "A cancellation reason is required.");
        var inv = await _db.SalesInvoices.Include(i => i.Lines).FirstOrDefaultAsync(i => i.Id == id && i.BusinessId == _user.BusinessId)
                  ?? throw AppException.NotFound("Invoice");
        if (inv.Status != "POSTED") throw new AppException("bad_status", "Only posted invoices can be cancelled.");
        if (inv.ReturnedAmount > 0) throw new AppException("has_returns", "This invoice has returns. Use a sales return for the remaining items.");
        var stop = await _db.DeliveryStops.Include(s => s.Lines).FirstOrDefaultAsync(s => s.InvoiceId == inv.Id);
        if (stop != null && stop.Status != "PENDING") throw new AppException("delivered", "This invoice was already processed on a delivery route. Use a sales return.");

        await _post.LockAsync("ProductVariations", inv.Lines.Select(l => l.VariationId));
        var now = DateTime.UtcNow;
        var vids = inv.Lines.Select(l => l.VariationId).Distinct().ToList();
        var vmap = await _db.ProductVariations.Where(v => vids.Contains(v.Id)).ToDictionaryAsync(v => v.Id);
        var missingVariation = vids.FirstOrDefault(id => !vmap.ContainsKey(id));
        if (missingVariation != Guid.Empty)
            throw new AppException("missing_product", "This invoice refers to a product size that no longer exists. Restore the product data before cancelling the invoice.");
        foreach (var l in inv.Lines)
            await _post.FinishedInAsync(vmap[l.VariationId], l.Quantity, l.UnitCost, "SALE_CANCEL", "SalesInvoice", inv.Id, now, reason);
        _post.CustomerEntry(inv.CustomerId, "INVOICE_CANCEL", 0, inv.Total, "SalesInvoice", inv.Id, now, $"Cancelled invoice {inv.InvoiceNo}: {reason}");

        if (stop != null)
        {
            _db.DeliveryLines.RemoveRange(stop.Lines);
            _db.DeliveryStops.Remove(stop);
        }
        inv.Status = "CANCELLED";
        inv.CancelledAt = now; inv.CancelledBy = _user.UserId; inv.CancelReason = reason;
        inv.DeliveryStatus = "NOT_REQUIRED";
        inv.Version++;
        _post.Audit("CANCEL", "SalesInvoice", inv.Id, $"Invoice {inv.InvoiceNo} cancelled: {reason}. Any payment stays as customer credit.");
        await _db.SaveChangesAsync();
        await _post.ReallocateAsync(inv.CustomerId);
    }

    /// <summary>
    /// Records a return against an invoice. Saleable (GOOD) packets go back to finished stock at their
    /// original cost; damaged/expired/wrong items go to the DAMAGED bucket. The customer is credited,
    /// or refunded in cash when Settlement = CASH_REFUND.
    /// </summary>
    public async Task<PostResult> CreateReturnAsync(ReturnInput input, string origin = "MANUAL", bool internalCall = false)
    {
        if (!internalCall) _user.Require(Perm.ReturnsCreate);
        if (input.Id == Guid.Empty) throw new AppException("bad_id", "Return id is required.");
        var existing = await _db.SalesReturns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == input.Id);
        if (existing != null) return PostResult.Duplicate(existing.Id, existing.ReturnNo);
        if (input.Lines == null || input.Lines.Count == 0) throw new AppException("no_lines", "Select at least one item to return.");

        await _post.LockAsync("SalesInvoices", new[] { input.InvoiceId });
        var inv = await _db.SalesInvoices.Include(i => i.Lines).FirstOrDefaultAsync(i => i.Id == input.InvoiceId && i.BusinessId == _user.BusinessId)
                  ?? throw AppException.NotFound("Invoice");
        if (inv.Status != "POSTED") throw new AppException("bad_status", "Returns can only be recorded against posted invoices.");

        var settlement = string.IsNullOrWhiteSpace(input.Settlement) ? "CREDIT" : Methods.Upper(input.Settlement);
        if (settlement != "CREDIT" && settlement != "CASH_REFUND") throw new AppException("bad_settlement", "Settlement must be CREDIT or CASH_REFUND.");

        var number = await _numbers.ResolveAsync(input.ReturnNo, "RET", "RETURN");
        var at = input.ReturnDate == default ? DateTime.UtcNow : input.ReturnDate.ToUniversalTime();
        var ret = new SalesReturn
        {
            Id = input.Id, BusinessId = _user.BusinessId, ReturnNo = number, InvoiceId = inv.Id, CustomerId = inv.CustomerId,
            ReturnDate = at, Origin = origin, Settlement = settlement, Reason = input.Reason, DeviceId = _user.DeviceId, CreatedBy = _user.UserId
        };

        var vids = inv.Lines.Select(l => l.VariationId).Distinct().ToList();
        await _post.LockAsync("ProductVariations", vids);
        var vmap = await _db.ProductVariations.Where(v => vids.Contains(v.Id)).ToDictionaryAsync(v => v.Id);

        foreach (var g in input.Lines.GroupBy(x => x.InvoiceLineId))
        {
            var line = inv.Lines.FirstOrDefault(l => l.Id == g.Key) ?? throw new AppException("bad_line", "A returned item is not on this invoice.");
            foreach (var rl in g)
            {
                if (rl.Quantity <= 0) throw new AppException("bad_quantity", "Return quantities must be greater than zero.");
                var condition = Methods.Upper(rl.Condition);
                if (condition is not ("GOOD" or "DAMAGED" or "EXPIRED" or "WRONG_ITEM")) throw new AppException("bad_condition", "Unknown item condition.");
                if (line.ReturnedQty + rl.Quantity > line.Quantity)
                    throw new AppException("too_many", $"{line.Description}: only {line.Quantity - line.ReturnedQty} packets can still be returned.");

                var netUnit = line.LineTotal / line.Quantity;
                var lineTotal = Money.R2(netUnit * rl.Quantity);
                var restock = condition == "GOOD";
                ret.Lines.Add(new SalesReturnLine
                {
                    ReturnId = ret.Id, InvoiceLineId = line.Id, VariationId = line.VariationId, Quantity = rl.Quantity,
                    UnitPrice = Math.Round(netUnit, 4), LineTotal = lineTotal, Condition = condition, Restock = restock, UnitCost = line.UnitCost
                });
                line.ReturnedQty += rl.Quantity;

                var v = vmap[line.VariationId];
                if (restock)
                    await _post.FinishedInAsync(v, rl.Quantity, line.UnitCost, "SALE_RETURN", "SalesReturn", ret.Id, at, $"{condition} return {number}");
                else
                    _post.Damaged(v.ProductId, v.Id, "PKT", rl.Quantity, line.UnitCost, "SALE_RETURN", "SalesReturn", ret.Id, at, $"{condition} return {number}");
            }
        }

        ret.Total = ret.Lines.Sum(l => l.LineTotal);
        inv.ReturnedAmount += ret.Total;
        inv.Version++;
        _db.SalesReturns.Add(ret);
        _post.CustomerEntry(inv.CustomerId, "RETURN", 0, ret.Total, "SalesReturn", ret.Id, at, $"Return {number} on {inv.InvoiceNo}");

        if (settlement == "CASH_REFUND" && ret.Total > 0)
        {
            var account = await _post.AccountForAsync("CASH", input.RefundAccountId);
            ret.RefundAccountId = account.Id;
            _post.Cash(account.Id, -ret.Total, "REFUND", ret.Id, at, $"Refund for return {number}");
            _post.CustomerEntry(inv.CustomerId, "REFUND", ret.Total, 0, "SalesReturn", ret.Id, at, $"Cash refund for {number}");
        }

        _post.Audit("CREATE", "SalesReturn", ret.Id, $"Return {number} on {inv.InvoiceNo}, total {ret.Total:0.00} ({origin})");
        await _db.SaveChangesAsync();
        await _post.ReallocateAsync(inv.CustomerId);
        return PostResult.Applied(ret.Id, number, null, new { total = ret.Total });
    }
}
