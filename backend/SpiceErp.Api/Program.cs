using System.Text;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.FileProviders;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
#if !NO_SWAGGER
using Microsoft.OpenApi.Models;
#endif
using Npgsql;
using SpiceErp.Api.Controllers;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Reports;
using SpiceErp.Api.Security;
using SpiceErp.Api.Services;

var builder = WebApplication.CreateBuilder(args);
var cfg = builder.Configuration;

// ---------------------------------------------------------------- database (EF Core + Dapper share one data source)
var connString = cfg.GetConnectionString("Default") ?? throw new InvalidOperationException("ConnectionStrings:Default is not configured.");
var dataSource = new NpgsqlDataSourceBuilder(connString).Build();
builder.Services.AddSingleton(dataSource);
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(dataSource));

// ---------------------------------------------------------------- security
var jwt = cfg.GetSection("Jwt").Get<JwtOptions>() ?? new JwtOptions();
if (string.IsNullOrWhiteSpace(jwt.Key) || Encoding.UTF8.GetByteCount(jwt.Key) < 32)
    throw new InvalidOperationException("Jwt:Key must be set to a secret of at least 32 characters (use an environment variable or user secrets, never source control).");
builder.Services.AddSingleton(jwt);
builder.Services.AddSingleton<JwtTokenService>();
builder.Services.AddSingleton<IPasswordHasher<User>, PasswordHasher<User>>();

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.MapInboundClaims = false;
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true, ValidIssuer = jwt.Issuer, ValidateAudience = true, ValidAudience = jwt.Audience,
        ValidateIssuerSigningKey = true, IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Key)),
        ValidateLifetime = true, ClockSkew = TimeSpan.FromMinutes(2),
        NameClaimType = "name", RoleClaimType = System.Security.Claims.ClaimTypes.Role
    };
});
builder.Services.AddAuthorization(o =>
{
    foreach (var p in Perm.All) o.AddPolicy(p, pb => pb.RequireAuthenticatedUser().RequireClaim("perm", p));
});
// JwtBearer with MapInboundClaims=false keeps "sub"-style names; map our NameIdentifier claim explicitly.
System.IdentityModel.Tokens.Jwt.JwtSecurityTokenHandler.DefaultMapInboundClaims = false;

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) }));
    o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
        RateLimitPartition.GetFixedWindowLimiter(ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = 600, Window = TimeSpan.FromMinutes(1) }));
});

var origins = cfg.GetSection("Cors:Origins").Get<string[]>() ?? new[] { "http://localhost:4200" };
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod()));

// ---------------------------------------------------------------- application services
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, CurrentUser>();
builder.Services.AddScoped<PostingService>();
builder.Services.AddScoped<Numbering>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<FinanceService>();
builder.Services.AddScoped<SalesService>();
builder.Services.AddScoped<PurchaseService>();
builder.Services.AddScoped<PackingService>();
builder.Services.AddScoped<InventoryService>();
builder.Services.AddScoped<DeliveryService>();
builder.Services.AddScoped<CustomerService>();
builder.Services.AddScoped<SyncService>();
builder.Services.AddScoped<ReportQueries>();

builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
});
builder.Services.Configure<Microsoft.AspNetCore.Mvc.ApiBehaviorOptions>(o =>
{
    o.InvalidModelStateResponseFactory = ctx =>
    {
        var details = ctx.ModelState.Where(kv => kv.Value?.Errors.Count > 0).ToDictionary(kv => kv.Key, kv => kv.Value!.Errors.Select(e => e.ErrorMessage));
        return new Microsoft.AspNetCore.Mvc.BadRequestObjectResult(new { error = new { code = "validation", message = "Some fields are invalid.", details, traceId = ctx.HttpContext.TraceIdentifier } });
    };
});

builder.Services.AddEndpointsApiExplorer();
#if !NO_SWAGGER
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Spice ERP API", Version = "v1" });
    c.CustomSchemaIds(t => t.FullName?.Replace("+", "."));
    c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme { Type = SecuritySchemeType.Http, Scheme = "bearer", BearerFormat = "JWT", In = ParameterLocation.Header });
    c.AddSecurityRequirement(new OpenApiSecurityRequirement { { new OpenApiSecurityScheme { Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" } }, Array.Empty<string>() } });
});
#endif
builder.Services.AddHealthChecks();

var app = builder.Build();

// ---------------------------------------------------------------- pipeline
app.UseForwardedHeaders(new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto });
app.UseMiddleware<ErrorHandlingMiddleware>();
if (!app.Environment.IsDevelopment()) app.UseHsts();
if (cfg.GetValue("Https:Redirect", false)) app.UseHttpsRedirection();

app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["X-Frame-Options"] = "DENY";
    await next();
});

#if !NO_SWAGGER
if (cfg.GetValue("Swagger:Enabled", app.Environment.IsDevelopment()))
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
#endif

var uploadRoot = UploadsController.UploadRoot(app.Environment, cfg);
Directory.CreateDirectory(uploadRoot);
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploadRoot), RequestPath = "/uploads",
    OnPrepareResponse = ctx => ctx.Context.Response.Headers["Cache-Control"] = "public,max-age=31536000,immutable"
});

app.UseCors();
app.UseAuthentication();
app.UseRateLimiter();
app.UseAuthorization();
app.MapControllers();
app.MapHealthChecks("/health");

// Optionally serve the built Angular app from wwwroot (single-container deployment).
if (Directory.Exists(Path.Combine(app.Environment.ContentRootPath, "wwwroot")))
{
    app.UseDefaultFiles();
    app.UseStaticFiles();
    app.MapFallbackToFile("index.html");
}

await DbInitializer.InitializeAsync(app.Services, cfg, app.Logger);
app.Run();

public partial class Program { }
