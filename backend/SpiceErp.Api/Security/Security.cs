using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using SpiceErp.Api.Data;

namespace SpiceErp.Api.Security;

/// <summary>All permissions. Enforced on the server by [Authorize(Policy = ...)] and in services.</summary>
public static class Perm
{
    public const string ProductsView = "products.view";
    public const string ProductsManage = "products.manage";
    public const string PurchasesView = "purchases.view";
    public const string PurchasesManage = "purchases.manage";
    public const string InventoryView = "inventory.view";
    public const string InventoryAdjust = "inventory.adjust";
    public const string PackingManage = "packing.manage";
    public const string PackingPost = "packing.post";
    public const string CustomersView = "customers.view";
    public const string CustomersManage = "customers.manage";
    public const string SuppliersView = "suppliers.view";
    public const string SuppliersManage = "suppliers.manage";
    public const string SalesView = "sales.view";
    public const string SalesCreate = "sales.create";
    public const string SalesCancel = "sales.cancel";
    public const string SalesDiscount = "sales.discount";
    public const string ReturnsCreate = "returns.create";
    public const string DeliveryManage = "delivery.manage";
    public const string DeliveryExecute = "delivery.execute";
    public const string ReceiptsCreate = "receipts.create";
    public const string PaymentsManage = "payments.manage";
    public const string ExpensesCreate = "expenses.create";
    public const string ReportsView = "reports.view";
    public const string ReportsFinancial = "reports.financial";
    public const string UsersManage = "users.manage";
    public const string SettingsManage = "settings.manage";
    public const string AuditView = "audit.view";
    public const string SyncReview = "sync.review";

    public static readonly string[] All =
    {
        ProductsView, ProductsManage, PurchasesView, PurchasesManage, InventoryView, InventoryAdjust,
        PackingManage, PackingPost, CustomersView, CustomersManage, SuppliersView, SuppliersManage,
        SalesView, SalesCreate, SalesCancel, SalesDiscount, ReturnsCreate, DeliveryManage, DeliveryExecute,
        ReceiptsCreate, PaymentsManage, ExpensesCreate, ReportsView, ReportsFinancial, UsersManage,
        SettingsManage, AuditView, SyncReview
    };

    public static readonly Dictionary<string, string[]> ByRole = new()
    {
        ["Owner"] = All,
        ["Storekeeper"] = new[] { ProductsView, PurchasesView, PurchasesManage, InventoryView, PackingManage, PackingPost, SuppliersView, ReportsView },
        ["Packer"] = new[] { ProductsView, InventoryView, PackingPost },
        ["Salesperson"] = new[] { ProductsView, CustomersView, CustomersManage, SalesView, SalesCreate, ReturnsCreate, ReceiptsCreate, DeliveryExecute },
        ["Delivery"] = new[] { ProductsView, CustomersView, SalesView, ReturnsCreate, ReceiptsCreate, DeliveryExecute, ExpensesCreate },
        ["Accountant"] = new[] { ProductsView, CustomersView, SuppliersView, SuppliersManage, SalesView, PurchasesView, ReceiptsCreate, PaymentsManage, ExpensesCreate, ReportsView, ReportsFinancial },
    };

    public static string[] ForRoles(IEnumerable<string> roles) =>
        roles.SelectMany(r => ByRole.TryGetValue(r, out var p) ? p : Array.Empty<string>()).Distinct().OrderBy(x => x).ToArray();
}

public class JwtOptions
{
    public string Issuer { get; set; } = "SpiceErp";
    public string Audience { get; set; } = "SpiceErp.Clients";
    public string Key { get; set; } = "";
    public int AccessTokenHours { get; set; } = 12;
}

public class JwtTokenService
{
    private readonly JwtOptions _opt;
    public JwtTokenService(JwtOptions opt) { _opt = opt; }

    public (string token, DateTime expiresAt) Create(User user, IEnumerable<string> roles, string[] permissions, Guid deviceId)
    {
        var expires = DateTime.UtcNow.AddHours(_opt.AccessTokenHours);
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new("bid", user.BusinessId.ToString()),
            new("did", deviceId.ToString()),
            new("name", user.FullName),
        };
        claims.AddRange(roles.Select(r => new Claim(ClaimTypes.Role, r)));
        claims.AddRange(permissions.Select(p => new Claim("perm", p)));

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_opt.Key));
        var token = new JwtSecurityToken(_opt.Issuer, _opt.Audience, claims, DateTime.UtcNow, expires,
            new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }
}
