using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record CustomerInput(Guid Id, int? BaseVersion, string? Code, string ShopName, string? ContactPerson, string? Phone,
    string? WhatsApp, string? Address, string? Area, string? City, decimal? Latitude, decimal? Longitude, string? CustomerType,
    Guid? SalespersonId, Guid? RouteId, decimal CreditLimit, int PaymentTermsDays, decimal OpeningBalance, string? Notes, bool IsActive = true);

/// <summary>
/// Customer create/update, shared by the REST API and offline sync. Updates use optimistic
/// versioning: a device editing an out-of-date copy gets a conflict and the server copy wins.
/// </summary>
public class CustomerService
{
    private readonly AppDbContext _db;
    private readonly PostingService _post;
    private readonly ICurrentUser _user;

    public CustomerService(AppDbContext db, PostingService post, ICurrentUser user) { _db = db; _post = post; _user = user; }

    public async Task<PostResult> UpsertAsync(CustomerInput input, Guid? opKey = null)
    {
        _user.Require(Perm.CustomersManage);
        if (string.IsNullOrWhiteSpace(input.ShopName)) throw new AppException("required", "Shop name is required.");
        var type = string.IsNullOrWhiteSpace(input.CustomerType) ? "RETAILER" : Methods.Upper(input.CustomerType);
        if (type is not ("RETAILER" or "WHOLESALER" or "DISTRIBUTOR")) throw new AppException("bad_type", "Unknown customer type.");
        if (input.CreditLimit < 0) throw new AppException("bad_amount", "Credit limit cannot be negative.");

        var id = input.Id == Guid.Empty ? Guid.NewGuid() : input.Id;
        var c = await _db.Customers.FirstOrDefaultAsync(x => x.Id == id);
        var isNew = c == null;
        var warnings = new List<string>();

        if (c != null)
        {
            if (c.BusinessId != _user.BusinessId) throw AppException.Forbidden();
            if (input.BaseVersion.HasValue && input.BaseVersion.Value != c.Version)
            {
                _post.Conflict("CUSTOMER_EDIT", "Customer", c.Id, $"{c.ShopName} was changed on the server (v{c.Version}) after this device's copy (v{input.BaseVersion}). Server copy kept.", opKey);
                await _db.SaveChangesAsync();
                return new PostResult(c.Id, c.Code, "conflict", new List<string> { "The customer was changed elsewhere; the server version was kept." });
            }
        }
        else
        {
            var phone = input.Phone?.Trim();
            if (!string.IsNullOrEmpty(phone) && await _db.Customers.AnyAsync(x => x.BusinessId == _user.BusinessId && x.Phone == phone))
                warnings.Add($"Another customer already uses phone {phone}. Check for duplicates.");
            if (await _db.Customers.AnyAsync(x => x.BusinessId == _user.BusinessId && x.ShopName.ToLower() == input.ShopName.Trim().ToLower() && x.Area == input.Area))
                warnings.Add("A customer with the same shop name and area already exists.");
            c = new Customer
            {
                Id = id, BusinessId = _user.BusinessId,
                Code = string.IsNullOrWhiteSpace(input.Code) ? await _post.NextNumberAsync("CUSTOMER", "C") : input.Code.Trim(),
                OpeningBalance = Money.R2(input.OpeningBalance)
            };
            _db.Customers.Add(c);
        }

        c.ShopName = input.ShopName.Trim();
        c.ContactPerson = input.ContactPerson; c.Phone = input.Phone?.Trim(); c.WhatsApp = input.WhatsApp;
        c.Address = input.Address; c.Area = input.Area; c.City = input.City; c.Latitude = input.Latitude; c.Longitude = input.Longitude;
        c.CustomerType = type; c.SalespersonId = input.SalespersonId; c.RouteId = input.RouteId;
        c.CreditLimit = Money.R2(input.CreditLimit); c.PaymentTermsDays = Math.Max(0, input.PaymentTermsDays);
        c.Notes = input.Notes; c.IsActive = input.IsActive; c.UpdatedAt = DateTime.UtcNow;
        if (!isNew) c.Version++;

        await _db.SaveChangesAsync();
        if (isNew && c.OpeningBalance != 0)
        {
            _post.CustomerEntry(c.Id, "OPENING", Math.Max(c.OpeningBalance, 0), Math.Max(-c.OpeningBalance, 0), "Customer", c.Id, DateTime.UtcNow, "Opening balance");
        }
        _post.Audit(isNew ? "CREATE" : "UPDATE", "Customer", c.Id, $"{(isNew ? "Created" : "Updated")} customer {c.Code} {c.ShopName}");
        await _db.SaveChangesAsync();
        return PostResult.Applied(c.Id, c.Code, warnings, new { version = c.Version, code = c.Code });
    }
}
