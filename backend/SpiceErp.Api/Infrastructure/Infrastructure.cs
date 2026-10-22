using System.Security.Claims;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace SpiceErp.Api.Infrastructure;

/// <summary>Business-rule failure that is safe to show to the user.</summary>
public class AppException : Exception
{
    public int StatusCode { get; }
    public string Code { get; }
    public object? Details { get; }

    public AppException(string code, string message, int statusCode = 400, object? details = null) : base(message)
    {
        Code = code; StatusCode = statusCode; Details = details;
    }

    public static AppException NotFound(string what) => new("not_found", $"{what} was not found.", 404);
    public static AppException Forbidden(string message = "You do not have permission for this action.") => new("forbidden", message, 403);
    public static AppException Conflict(string message) => new("conflict", message, 409);
}

/// <summary>Uniform error envelope: { "error": { "code", "message", "details", "traceId" } }.</summary>
public class ErrorHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ErrorHandlingMiddleware> _log;

    public ErrorHandlingMiddleware(RequestDelegate next, ILogger<ErrorHandlingMiddleware> log) { _next = next; _log = log; }

    public async Task Invoke(HttpContext ctx)
    {
        try
        {
            await _next(ctx);
        }
        catch (AppException ex)
        {
            await Write(ctx, ex.StatusCode, ex.Code, ex.Message, ex.Details);
        }
        catch (DbUpdateConcurrencyException)
        {
            await Write(ctx, 409, "concurrency", "This record was changed by someone else. Reload and try again.", null);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException pg && pg.SqlState == "23505")
        {
            await Write(ctx, 409, "duplicate", "A record with the same unique value already exists.", pg.ConstraintName);
        }
        catch (PostgresException pg) when (pg.SqlState == "23505")
        {
            await Write(ctx, 409, "duplicate", "A record with the same unique value already exists.", pg.ConstraintName);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Unhandled error on {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            await Write(ctx, 500, "server_error", "An unexpected server error occurred.", null);
        }
    }

    public static Task Write(HttpContext ctx, int status, string code, string message, object? details)
    {
        if (ctx.Response.HasStarted) return Task.CompletedTask;
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        var body = new { error = new { code, message, details, traceId = ctx.TraceIdentifier } };
        return ctx.Response.WriteAsync(JsonSerializer.Serialize(body, JsonDefaults.Options));
    }
}

public static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

/// <summary>The authenticated user for the current request.</summary>
public interface ICurrentUser
{
    Guid UserId { get; }
    Guid BusinessId { get; }
    Guid? DeviceId { get; }
    string FullName { get; }
    bool Has(string permission);
    void Require(string permission);
    string? IpAddress { get; }
}

public class CurrentUser : ICurrentUser
{
    private readonly IHttpContextAccessor _http;
    public CurrentUser(IHttpContextAccessor http) { _http = http; }

    private ClaimsPrincipal Principal => _http.HttpContext?.User ?? new ClaimsPrincipal();

    private Guid ClaimGuid(string type)
    {
        var v = Principal.FindFirst(type)?.Value;
        return Guid.TryParse(v, out var g) ? g : throw new AppException("unauthorized", "Not signed in.", 401);
    }

    public Guid UserId => ClaimGuid(ClaimTypes.NameIdentifier);
    public Guid BusinessId => ClaimGuid("bid");
    public Guid? DeviceId => Guid.TryParse(Principal.FindFirst("did")?.Value, out var g) ? g : null;
    public string FullName => Principal.FindFirst("name")?.Value ?? "";
    public string? IpAddress => _http.HttpContext?.Connection.RemoteIpAddress?.ToString();
    public bool Has(string permission) => Principal.HasClaim("perm", permission);
    public void Require(string permission) { if (!Has(permission)) throw AppException.Forbidden(); }
}

public static class Money
{
    public static decimal R2(decimal v) => Math.Round(v, 2, MidpointRounding.AwayFromZero);
    public static decimal R6(decimal v) => Math.Round(v, 6, MidpointRounding.AwayFromZero);
}

public record PagedResult<T>(IReadOnlyList<T> Items, int Total, int Page, int PageSize);
