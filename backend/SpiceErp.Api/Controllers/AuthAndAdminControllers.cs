using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;
using SpiceErp.Api.Services;

namespace SpiceErp.Api.Controllers;

[ApiController, Route("api/auth")]
public class AuthController : ControllerBase
{
    private readonly AuthService _auth;
    private readonly ICurrentUser _user;
    private readonly AppDbContext _db;
    public AuthController(AuthService auth, ICurrentUser user, AppDbContext db) { _auth = auth; _user = user; _db = db; }

    [HttpPost("login"), AllowAnonymous, EnableRateLimiting("login")]
    public async Task<IActionResult> Login(LoginInput input) =>
        Ok(await _auth.LoginAsync(input, HttpContext.Connection.RemoteIpAddress?.ToString()));

    [HttpGet("me"), Authorize]
    public async Task<IActionResult> Me()
    {
        var u = await _db.Users.Include(x => x.Roles).FirstAsync(x => x.Id == _user.UserId);
        var roles = u.Roles.Select(r => r.RoleCode).ToArray();
        return Ok(new { id = u.Id, username = u.Username, fullName = u.FullName, roles, permissions = Perm.ForRoles(roles), preferredLanguage = u.PreferredLanguage });
    }

    [HttpPost("change-password"), Authorize]
    public async Task<IActionResult> ChangePassword(ChangePasswordInput input)
    {
        await _auth.ChangePasswordAsync(_user.UserId, input);
        return NoContent();
    }

    public record LanguageInput(string Language);

    [HttpPut("language"), Authorize]
    public async Task<IActionResult> SetLanguage(LanguageInput input)
    {
        if (input.Language is not ("en" or "ur")) throw new AppException("bad_language", "Language must be en or ur.");
        var u = await _db.Users.FirstAsync(x => x.Id == _user.UserId);
        u.PreferredLanguage = input.Language; u.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return NoContent();
    }
}

public record UserInput(string Username, string FullName, string? Phone, string? Password, List<string> Roles, bool IsActive = true, string PreferredLanguage = "en");
public record ResetPasswordInput(string NewPassword);

[ApiController, Route("api/users"), Authorize(Policy = Perm.UsersManage)]
public class UsersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly IPasswordHasher<User> _hasher;
    private readonly PostingService _post;
    public UsersController(AppDbContext db, ICurrentUser user, IPasswordHasher<User> hasher, PostingService post) { _db = db; _user = user; _hasher = hasher; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List() => Ok(await _db.Users.Where(u => u.BusinessId == _user.BusinessId).OrderBy(u => u.FullName)
        .Select(u => new { u.Id, u.Username, u.FullName, u.Phone, u.IsActive, u.PreferredLanguage, u.LockedUntil, roles = u.Roles.Select(r => r.RoleCode) }).ToListAsync());

    [HttpGet("roles"), Authorize]
    public async Task<IActionResult> Roles() => Ok(await _db.Roles.OrderBy(r => r.Code).ToListAsync());

    [HttpPost]
    public async Task<IActionResult> Create(UserInput input)
    {
        Validate(input);
        AuthService.ValidatePasswordStrength(input.Password ?? "");
        var uname = input.Username.Trim();
        if (await _db.Users.AnyAsync(u => u.BusinessId == _user.BusinessId && u.Username.ToLower() == uname.ToLower()))
            throw AppException.Conflict("This username is already taken.");
        var u = new User { BusinessId = _user.BusinessId, Username = uname, FullName = input.FullName.Trim(), Phone = input.Phone, IsActive = input.IsActive, PreferredLanguage = input.PreferredLanguage };
        u.PasswordHash = _hasher.HashPassword(u, input.Password!);
        foreach (var r in input.Roles.Distinct()) u.Roles.Add(new UserRole { UserId = u.Id, RoleCode = r });
        _db.Users.Add(u);
        _post.Audit("CREATE", "User", u.Id, $"User {u.Username} created with roles {string.Join(", ", input.Roles)}");
        await _db.SaveChangesAsync();
        return Ok(new { u.Id });
    }

    [HttpPut("{id:guid}")]
    public async Task<IActionResult> Update(Guid id, UserInput input)
    {
        Validate(input);
        var u = await _db.Users.Include(x => x.Roles).FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("User");
        if (u.Id == _user.UserId && (!input.IsActive || !input.Roles.Contains("Owner")) && u.Roles.Any(r => r.RoleCode == "Owner"))
            throw new AppException("self_lockout", "You cannot remove your own owner access or deactivate yourself.");
        u.FullName = input.FullName.Trim(); u.Phone = input.Phone; u.IsActive = input.IsActive; u.PreferredLanguage = input.PreferredLanguage; u.UpdatedAt = DateTime.UtcNow;
        _db.UserRoles.RemoveRange(u.Roles);
        foreach (var r in input.Roles.Distinct()) _db.UserRoles.Add(new UserRole { UserId = u.Id, RoleCode = r });
        _post.Audit("UPDATE", "User", u.Id, $"User {u.Username}: roles {string.Join(", ", input.Roles)}, active {input.IsActive}");
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost("{id:guid}/reset-password")]
    public async Task<IActionResult> ResetPassword(Guid id, ResetPasswordInput input)
    {
        AuthService.ValidatePasswordStrength(input.NewPassword);
        var u = await _db.Users.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("User");
        u.PasswordHash = _hasher.HashPassword(u, input.NewPassword); u.LockedUntil = null; u.FailedLogins = 0; u.UpdatedAt = DateTime.UtcNow;
        _post.Audit("PASSWORD_RESET", "User", u.Id, $"Password reset for {u.Username}");
        await _db.SaveChangesAsync();
        return NoContent();
    }

    private static void Validate(UserInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Username) || string.IsNullOrWhiteSpace(input.FullName)) throw new AppException("required", "Username and full name are required.");
        if (input.Roles == null || input.Roles.Count == 0) throw new AppException("roles_required", "Select at least one role.");
        if (input.Roles.Any(r => !Perm.ByRole.ContainsKey(r))) throw new AppException("bad_role", "Unknown role.");
        if (input.PreferredLanguage is not ("en" or "ur")) throw new AppException("bad_language", "Language must be en or ur.");
    }
}

[ApiController, Route("api/devices"), Authorize(Policy = Perm.UsersManage)]
public class DevicesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly PostingService _post;
    public DevicesController(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List() => Ok(await (
        from d in _db.Devices
        where d.BusinessId == _user.BusinessId
        join u in _db.Users on d.LastUserId equals (Guid?)u.Id into uj
        from u in uj.DefaultIfEmpty()
        orderby d.Prefix
        select new { d.Id, d.Name, d.Prefix, d.IsRevoked, d.RegisteredAt, d.LastSeenAt, d.LastPushAt, d.LastPullAt, lastUser = u == null ? null : u.FullName }).ToListAsync());

    public record RevokeInput(bool Revoked);

    [HttpPut("{id:guid}/revoked")]
    public async Task<IActionResult> SetRevoked(Guid id, RevokeInput input)
    {
        var d = await _db.Devices.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Device");
        if (d.Id == _user.DeviceId && input.Revoked) throw new AppException("self_revoke", "You cannot revoke the device you are using.");
        d.IsRevoked = input.Revoked;
        _post.Audit(input.Revoked ? "REVOKE" : "RESTORE", "Device", d.Id, $"Device {d.Prefix} {(input.Revoked ? "revoked" : "restored")}");
        await _db.SaveChangesAsync();
        return NoContent();
    }
}

public record BusinessInput(string Name, string? NameUr, string? Address, string? AddressUr, string? Phone, string? LogoUrl,
    string? InvoiceTerms, string? InvoiceTermsUr, string CurrencySymbol, bool AllowNegativeStock);

[ApiController, Route("api/settings"), Authorize]
public class SettingsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly PostingService _post;
    public SettingsController(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    [HttpGet("business")]
    public async Task<IActionResult> Get() => Ok(await _db.Businesses.FirstAsync(b => b.Id == _user.BusinessId));

    [HttpPut("business"), Authorize(Policy = Perm.SettingsManage)]
    public async Task<IActionResult> Update(BusinessInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Business name is required.");
        var b = await _db.Businesses.FirstAsync(x => x.Id == _user.BusinessId);
        if (b.AllowNegativeStock != input.AllowNegativeStock)
            _post.Audit("SETTING", "Business", b.Id, $"Allow negative stock changed to {input.AllowNegativeStock}");
        b.Name = input.Name.Trim(); b.NameUr = input.NameUr; b.Address = input.Address; b.AddressUr = input.AddressUr; b.Phone = input.Phone;
        b.LogoUrl = input.LogoUrl; b.InvoiceTerms = input.InvoiceTerms; b.InvoiceTermsUr = input.InvoiceTermsUr;
        b.CurrencySymbol = string.IsNullOrWhiteSpace(input.CurrencySymbol) ? "Rs." : input.CurrencySymbol.Trim();
        b.AllowNegativeStock = input.AllowNegativeStock; b.UpdatedAt = DateTime.UtcNow;
        _post.Audit("UPDATE", "Business", b.Id, "Business settings updated");
        await _db.SaveChangesAsync();
        return Ok(b);
    }
}

[ApiController, Route("api/audit-logs"), Authorize(Policy = Perm.AuditView)]
public class AuditController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    public AuditController(AppDbContext db, ICurrentUser user) { _db = db; _user = user; }

    [HttpGet]
    public async Task<IActionResult> List(string? q, string? entityType, int page = 1, int pageSize = 50)
    {
        pageSize = Math.Clamp(pageSize, 10, 200); page = Math.Max(1, page);
        var query = _db.AuditLogs.Where(a => a.BusinessId == _user.BusinessId);
        if (!string.IsNullOrWhiteSpace(entityType)) query = query.Where(a => a.EntityType == entityType);
        if (!string.IsNullOrWhiteSpace(q)) query = query.Where(a => EF.Functions.ILike(a.Summary, $"%{q}%"));
        var total = await query.CountAsync();
        var items = await (from a in query
                           join u in _db.Users on a.UserId equals (Guid?)u.Id into uj
                           from u in uj.DefaultIfEmpty()
                           join d in _db.Devices on a.DeviceId equals (Guid?)d.Id into dj
                           from d in dj.DefaultIfEmpty()
                           orderby a.OccurredAt descending
                           select new { a.Id, a.OccurredAt, a.Action, a.EntityType, a.EntityId, a.Summary, a.IpAddress, user = u == null ? null : u.FullName, device = d == null ? null : d.Prefix })
            .Skip((page - 1) * pageSize).Take(pageSize).ToListAsync();
        return Ok(new { items, total, page, pageSize });
    }
}
