using Dapper;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;

namespace SpiceErp.Api.Services;

public record LoginInput(string Username, string Password, Guid DeviceId, string? DeviceName);
public record ChangePasswordInput(string CurrentPassword, string NewPassword);

public class AuthService
{
    private const int MaxFailedLogins = 5;
    private readonly AppDbContext _db;
    private readonly JwtTokenService _jwt;
    private readonly IPasswordHasher<User> _hasher;

    public AuthService(AppDbContext db, JwtTokenService jwt, IPasswordHasher<User> hasher) { _db = db; _jwt = jwt; _hasher = hasher; }

    public static void ValidatePasswordStrength(string password)
    {
        if (string.IsNullOrEmpty(password) || password.Length < 8 || !password.Any(char.IsLetter) || !password.Any(char.IsDigit))
            throw new AppException("weak_password", "Password must be at least 8 characters and contain letters and numbers.");
    }

    public async Task<object> LoginAsync(LoginInput input, string? ip)
    {
        if (input.DeviceId == Guid.Empty) throw new AppException("device_required", "Device id is required.");
        var uname = (input.Username ?? "").Trim().ToLower();
        var user = await _db.Users.Include(u => u.Roles).FirstOrDefaultAsync(u => u.Username.ToLower() == uname);
        var invalid = new AppException("invalid_login", "Incorrect username or password.", 401);
        if (user == null || !user.IsActive) throw invalid;
        if (user.LockedUntil.HasValue && user.LockedUntil > DateTime.UtcNow)
            throw new AppException("locked", "Too many failed attempts. Try again in a few minutes.", 423);

        if (_hasher.VerifyHashedPassword(user, user.PasswordHash, input.Password ?? "") == PasswordVerificationResult.Failed)
        {
            user.FailedLogins++;
            if (user.FailedLogins >= MaxFailedLogins) { user.LockedUntil = DateTime.UtcNow.AddMinutes(15); user.FailedLogins = 0; }
            await _db.SaveChangesAsync();
            throw invalid;
        }
        user.FailedLogins = 0; user.LockedUntil = null;

        var device = await _db.Devices.FirstOrDefaultAsync(d => d.Id == input.DeviceId);
        if (device != null && device.BusinessId != user.BusinessId) throw new AppException("device_conflict", "This device id is registered to another business.", 403);
        if (device?.IsRevoked == true) throw new AppException("device_revoked", "This device has been revoked by the owner.", 403);
        if (device == null)
        {
            var conn = _db.Database.GetDbConnection();
            await _db.Database.OpenConnectionAsync();
            var n = await conn.ExecuteScalarAsync<long>(
                @"INSERT INTO ""DocumentSequences"" (""BusinessId"",""DocType"",""Prefix"",""NextValue"") VALUES (@b,'DEVICE','D',2)
                  ON CONFLICT (""BusinessId"",""DocType"") DO UPDATE SET ""NextValue"" = ""DocumentSequences"".""NextValue"" + 1
                  RETURNING ""NextValue"" - 1", new { b = user.BusinessId });
            device = new Device
            {
                Id = input.DeviceId, BusinessId = user.BusinessId, Prefix = $"D{n:D2}",
                Name = string.IsNullOrWhiteSpace(input.DeviceName) ? $"Device {n}" : input.DeviceName!.Trim()
            };
            _db.Devices.Add(device);
            await _db.SaveChangesAsync();
            _db.AuditLogs.Add(new AuditLog { BusinessId = user.BusinessId, UserId = user.Id, DeviceId = device.Id, Action = "REGISTER", EntityType = "Device", EntityId = device.Id.ToString(), Summary = $"Device {device.Prefix} ({device.Name}) registered", IpAddress = ip });
        }
        device.LastUserId = user.Id; device.LastSeenAt = DateTime.UtcNow;
        if (!await _db.UserDeviceAssignments.AnyAsync(a => a.UserId == user.Id && a.DeviceId == device.Id))
            _db.UserDeviceAssignments.Add(new UserDeviceAssignment { UserId = user.Id, DeviceId = device.Id });
        _db.AuditLogs.Add(new AuditLog { BusinessId = user.BusinessId, UserId = user.Id, DeviceId = device.Id, Action = "LOGIN", EntityType = "User", EntityId = user.Id.ToString(), Summary = $"{user.Username} signed in", IpAddress = ip });
        await _db.SaveChangesAsync();

        var roles = user.Roles.Select(r => r.RoleCode).ToArray();
        var perms = Perm.ForRoles(roles);
        var (token, expires) = _jwt.Create(user, roles, perms, device.Id);
        return new
        {
            token, expiresAt = expires,
            user = new { id = user.Id, username = user.Username, fullName = user.FullName, roles, permissions = perms, preferredLanguage = user.PreferredLanguage },
            device = new { id = device.Id, prefix = device.Prefix, name = device.Name }
        };
    }

    public async Task ChangePasswordAsync(Guid userId, ChangePasswordInput input)
    {
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId) ?? throw AppException.NotFound("User");
        if (_hasher.VerifyHashedPassword(user, user.PasswordHash, input.CurrentPassword ?? "") == PasswordVerificationResult.Failed)
            throw new AppException("invalid_password", "The current password is incorrect.");
        ValidatePasswordStrength(input.NewPassword);
        user.PasswordHash = _hasher.HashPassword(user, input.NewPassword);
        user.UpdatedAt = DateTime.UtcNow;
        _db.AuditLogs.Add(new AuditLog { BusinessId = user.BusinessId, UserId = user.Id, Action = "PASSWORD", EntityType = "User", EntityId = user.Id.ToString(), Summary = "Password changed" });
        await _db.SaveChangesAsync();
    }
}
