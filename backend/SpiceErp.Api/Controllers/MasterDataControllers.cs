using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SpiceErp.Api.Data;
using SpiceErp.Api.Infrastructure;
using SpiceErp.Api.Security;
using SpiceErp.Api.Services;

namespace SpiceErp.Api.Controllers;

public record VariationInput(Guid? Id, string Sku, string? Barcode, int PacketGrams, decimal RetailPrice, decimal WholesalePrice,
    decimal? DealerPrice, decimal? MinPrice, int? TareGrams, Guid? PouchMaterialId, Guid? LabelMaterialId, int MinStockPackets, bool IsActive = true);

public record ProductInput(string Code, string Name, string? NameUr, Guid? CategoryId, string? SpiceType, string? Brand, string? Description,
    string? Barcode, long MinStockGrams, long ReorderGrams, bool TrackExpiry, decimal TaxRate, string? ImageUrl, bool IsActive,
    int? Version, List<VariationInput>? Variations);

[ApiController, Route("api/products"), Authorize(Policy = Perm.ProductsView)]
public class ProductsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly PostingService _post;
    public ProductsController(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(string? q, Guid? categoryId, bool? active, int page = 1, int pageSize = 100)
    {
        pageSize = Math.Clamp(pageSize, 10, 500); page = Math.Max(1, page);
        var query = _db.Products.Where(p => p.BusinessId == _user.BusinessId);
        if (!string.IsNullOrWhiteSpace(q))
            query = query.Where(p => EF.Functions.ILike(p.Name, $"%{q}%") || EF.Functions.ILike(p.Code, $"%{q}%") || (p.NameUr != null && p.NameUr.Contains(q)) || p.Barcode == q);
        if (categoryId.HasValue) query = query.Where(p => p.CategoryId == categoryId);
        if (active.HasValue) query = query.Where(p => p.IsActive == active);
        var total = await query.CountAsync();
        var items = await query.OrderBy(p => p.Name).Skip((page - 1) * pageSize).Take(pageSize)
            .Select(p => new
            {
                p.Id, p.Code, p.Name, p.NameUr, p.CategoryId, p.SpiceType, p.Brand, p.Description, p.Barcode, p.MinStockGrams, p.ReorderGrams,
                p.TrackExpiry, p.TaxRate, p.ImageUrl, p.IsActive, p.Version,
                bulkGrams = _db.InventoryTransactions.Where(t => t.ProductId == p.Id && t.Bucket == "BULK").Sum(t => (long?)t.Quantity) ?? 0,
                variations = p.Variations.OrderBy(v => v.PacketGrams).Select(v => new
                {
                    v.Id, v.Sku, v.Barcode, v.PacketGrams, v.RetailPrice, v.WholesalePrice, v.DealerPrice, v.MinPrice, v.TareGrams,
                    v.PouchMaterialId, v.LabelMaterialId, v.MinStockPackets, v.IsActive, v.Version,
                    avgCost = _user.Has(Perm.ReportsFinancial) ? v.AvgUnitCost : (decimal?)null,
                    packets = _db.InventoryTransactions.Where(t => t.VariationId == v.Id && t.Bucket == "FINISHED").Sum(t => (long?)t.Quantity) ?? 0
                })
            }).ToListAsync();
        return Ok(new { items, total, page, pageSize });
    }

    [HttpPost, Authorize(Policy = Perm.ProductsManage)]
    public async Task<IActionResult> Create(ProductInput input) => Ok(await _post.InTransactionAsync(async () =>
    {
        var p = new Product { BusinessId = _user.BusinessId };
        await Apply(p, input, true);
        _db.Products.Add(p);
        _post.Audit("CREATE", "Product", p.Id, $"Product {p.Code} {p.Name} with {p.Variations.Count} packet sizes");
        return new { p.Id };
    }));

    [HttpPut("{id:guid}"), Authorize(Policy = Perm.ProductsManage)]
    public async Task<IActionResult> Update(Guid id, ProductInput input) => Ok(await _post.InTransactionAsync(async () =>
    {
        var p = await _db.Products.Include(x => x.Variations).FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
                ?? throw AppException.NotFound("Product");
        if (input.Version.HasValue && input.Version != p.Version) throw AppException.Conflict("This product was changed by someone else. Reload and try again.");
        await Apply(p, input, false);
        p.Version++;
        return new { p.Id, p.Version };
    }));

    [HttpDelete("{id:guid}"), Authorize(Policy = Perm.ProductsManage)]
    public async Task<IActionResult> Delete(Guid id) => Ok(await _post.InTransactionAsync(async () =>
    {
        var p = await _db.Products.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId)
            ?? throw AppException.NotFound("Product");
        if (!p.IsActive) return new { p.Id, alreadyInactive = true };
        p.IsActive = false;
        p.UpdatedAt = DateTime.UtcNow;
        p.Version++;
        _post.Audit("DEACTIVATE", "Product", p.Id, $"Product {p.Code} {p.Name} deactivated");
        return new { p.Id, alreadyInactive = false };
    }));

    /// <summary>Bulk import. Existing product codes are skipped and reported.</summary>
    [HttpPost("import"), Authorize(Policy = Perm.ProductsManage)]
    public async Task<IActionResult> Import(List<ProductInput> items) => Ok(await _post.InTransactionAsync(async () =>
    {
        var created = 0; var skipped = new List<string>();
        foreach (var input in items)
        {
            var code = input.Code?.Trim() ?? "";
            if (await _db.Products.AnyAsync(x => x.BusinessId == _user.BusinessId && x.Code.ToLower() == code.ToLower())) { skipped.Add(code); continue; }
            var p = new Product { BusinessId = _user.BusinessId };
            await Apply(p, input, true);
            _db.Products.Add(p);
            await _db.SaveChangesAsync();
            created++;
        }
        _post.Audit("IMPORT", "Product", null, $"Imported {created} products, skipped {skipped.Count}");
        return new { created, skipped };
    }));

    private async Task Apply(Product p, ProductInput input, bool isNew)
    {
        if (string.IsNullOrWhiteSpace(input.Code) || string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Product code and name are required.");
        if (input.TaxRate < 0 || input.TaxRate > 100) throw new AppException("bad_tax", "Tax rate must be between 0 and 100.");
        var code = input.Code.Trim(); var name = input.Name.Trim();
        if (await _db.Products.AnyAsync(x => x.BusinessId == _user.BusinessId && x.Id != p.Id && (x.Code.ToLower() == code.ToLower() || x.Name.ToLower() == name.ToLower())))
            throw AppException.Conflict($"A product with code '{code}' or name '{name}' already exists.");
        if (input.CategoryId.HasValue && !await _db.ProductCategories.AnyAsync(c => c.Id == input.CategoryId && c.BusinessId == _user.BusinessId))
            throw AppException.NotFound("Category");

        p.Code = code; p.Name = name; p.NameUr = input.NameUr?.Trim(); p.CategoryId = input.CategoryId; p.SpiceType = input.SpiceType;
        p.Brand = input.Brand; p.Description = input.Description; p.Barcode = string.IsNullOrWhiteSpace(input.Barcode) ? null : input.Barcode.Trim();
        p.MinStockGrams = Math.Max(0, input.MinStockGrams); p.ReorderGrams = Math.Max(0, input.ReorderGrams); p.TrackExpiry = input.TrackExpiry;
        p.TaxRate = input.TaxRate; p.ImageUrl = input.ImageUrl; p.IsActive = input.IsActive; p.UpdatedAt = DateTime.UtcNow;

        var sizes = new HashSet<int>();
        foreach (var vi in input.Variations ?? new List<VariationInput>())
        {
            if (vi.PacketGrams <= 0) throw new AppException("bad_size", "Packet size must be greater than zero grams.");
            if (!sizes.Add(vi.PacketGrams)) throw new AppException("duplicate_size", $"Packet size {vi.PacketGrams} g is listed twice.");
            if (vi.RetailPrice < 0 || vi.WholesalePrice < 0 || vi.DealerPrice < 0 || vi.MinPrice < 0) throw new AppException("bad_price", "Prices cannot be negative.");
            var sku = string.IsNullOrWhiteSpace(vi.Sku) ? $"{code}-{vi.PacketGrams}" : vi.Sku.Trim();

            var v = vi.Id.HasValue ? p.Variations.FirstOrDefault(x => x.Id == vi.Id) : null;
            if (v == null)
            {
                v = new ProductVariation { BusinessId = _user.BusinessId, ProductId = p.Id };
                p.Variations.Add(v);
            }
            else if (v.RetailPrice != vi.RetailPrice || v.WholesalePrice != vi.WholesalePrice || v.MinPrice != vi.MinPrice)
            {
                _post.Audit("PRICE", "ProductVariation", v.Id, $"{p.Name} {v.PacketGrams} g: retail {v.RetailPrice:0.00}→{vi.RetailPrice:0.00}, wholesale {v.WholesalePrice:0.00}→{vi.WholesalePrice:0.00}");
                v.Version++;
            }
            if (await _db.ProductVariations.AnyAsync(x => x.BusinessId == _user.BusinessId && x.Id != v.Id && x.Sku.ToLower() == sku.ToLower()))
                throw AppException.Conflict($"SKU '{sku}' is already used.");
            v.Sku = sku; v.Barcode = string.IsNullOrWhiteSpace(vi.Barcode) ? null : vi.Barcode.Trim(); v.PacketGrams = vi.PacketGrams;
            v.RetailPrice = vi.RetailPrice; v.WholesalePrice = vi.WholesalePrice; v.DealerPrice = vi.DealerPrice; v.MinPrice = vi.MinPrice;
            v.TareGrams = vi.TareGrams; v.PouchMaterialId = vi.PouchMaterialId; v.LabelMaterialId = vi.LabelMaterialId;
            v.MinStockPackets = Math.Max(0, vi.MinStockPackets); v.IsActive = vi.IsActive; v.UpdatedAt = DateTime.UtcNow;
        }
        // Sizes missing from the input are deactivated, never deleted (they may have stock history).
        if (!isNew)
            foreach (var v in p.Variations.Where(v => !sizes.Contains(v.PacketGrams) && v.IsActive)) { v.IsActive = false; v.UpdatedAt = DateTime.UtcNow; }
    }
}

[ApiController, Route("api/product-categories"), Authorize(Policy = Perm.ProductsView)]
public class CategoriesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    public CategoriesController(AppDbContext db, ICurrentUser user) { _db = db; _user = user; }

    public record CategoryInput(string Name, string? NameUr, bool IsActive = true);

    [HttpGet] public async Task<IActionResult> List() => Ok(await _db.ProductCategories.Where(c => c.BusinessId == _user.BusinessId).OrderBy(c => c.Name).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.ProductsManage)]
    public async Task<IActionResult> Create(CategoryInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Name is required.");
        var c = new ProductCategory { BusinessId = _user.BusinessId, Name = input.Name.Trim(), NameUr = input.NameUr, IsActive = input.IsActive };
        _db.ProductCategories.Add(c);
        await _db.SaveChangesAsync();
        return Ok(c);
    }

    [HttpPut("{id:guid}"), Authorize(Policy = Perm.ProductsManage)]
    public async Task<IActionResult> Update(Guid id, CategoryInput input)
    {
        var c = await _db.ProductCategories.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Category");
        c.Name = input.Name.Trim(); c.NameUr = input.NameUr; c.IsActive = input.IsActive; c.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return Ok(c);
    }
}

[ApiController, Route("api/packaging-materials"), Authorize(Policy = Perm.InventoryView)]
public class MaterialsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    public MaterialsController(AppDbContext db, ICurrentUser user) { _db = db; _user = user; }

    public record MaterialInput(string Code, string Name, string? NameUr, string Kind, string? Unit, long MinStock, bool IsActive = true);

    [HttpGet, Authorize(Policy = Perm.ProductsView)]
    public async Task<IActionResult> List() => Ok(await _db.PackagingMaterials.Where(m => m.BusinessId == _user.BusinessId).OrderBy(m => m.Kind).ThenBy(m => m.Name)
        .Select(m => new { m.Id, m.Code, m.Name, m.NameUr, m.Kind, m.Unit, m.MinStock, m.IsActive, m.AvgUnitCost,
            quantity = _db.PackagingMaterialTransactions.Where(t => t.MaterialId == m.Id).Sum(t => (long?)t.Quantity) ?? 0 }).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.PurchasesManage)]
    public async Task<IActionResult> Create(MaterialInput input)
    {
        var m = new PackagingMaterial { BusinessId = _user.BusinessId };
        Apply(m, input);
        _db.PackagingMaterials.Add(m);
        await _db.SaveChangesAsync();
        return Ok(new { m.Id });
    }

    [HttpPut("{id:guid}"), Authorize(Policy = Perm.PurchasesManage)]
    public async Task<IActionResult> Update(Guid id, MaterialInput input)
    {
        var m = await _db.PackagingMaterials.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Material");
        Apply(m, input); m.Version++;
        await _db.SaveChangesAsync();
        return NoContent();
    }

    private static void Apply(PackagingMaterial m, MaterialInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Code) || string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Code and name are required.");
        var kind = Methods.Upper(input.Kind);
        if (kind is not ("POUCH" or "LABEL" or "WRAPPER" or "CARTON" or "SEALING" or "OTHER")) throw new AppException("bad_kind", "Unknown material type.");
        m.Code = input.Code.Trim(); m.Name = input.Name.Trim(); m.NameUr = input.NameUr; m.Kind = kind;
        m.Unit = string.IsNullOrWhiteSpace(input.Unit) ? "pcs" : input.Unit.Trim(); m.MinStock = Math.Max(0, input.MinStock); m.IsActive = input.IsActive; m.UpdatedAt = DateTime.UtcNow;
    }
}

public record SupplierInput(string? Code, string Name, string? ContactPerson, string? Phone, string? Address, string? City, decimal OpeningBalance, string? Notes, bool IsActive = true, int? Version = null);

[ApiController, Route("api/suppliers"), Authorize(Policy = Perm.SuppliersView)]
public class SuppliersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly PostingService _post;
    public SuppliersController(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(string? q) => Ok(await _db.Suppliers
        .Where(s => s.BusinessId == _user.BusinessId && (q == null || EF.Functions.ILike(s.Name, $"%{q}%") || s.Phone == q || EF.Functions.ILike(s.Code, $"%{q}%")))
        .OrderBy(s => s.Name)
        .Select(s => new { s.Id, s.Code, s.Name, s.ContactPerson, s.Phone, s.Address, s.City, s.Notes, s.IsActive, s.Version, s.OpeningBalance,
            balance = _db.SupplierLedgerEntries.Where(e => e.SupplierId == s.Id).Sum(e => (decimal?)(e.Credit - e.Debit)) ?? 0 }).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.SuppliersManage)]
    public async Task<IActionResult> Create(SupplierInput input) => Ok(await _post.InTransactionAsync(async () =>
    {
        if (string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Supplier name is required.");
        var s = new Supplier
        {
            BusinessId = _user.BusinessId, Code = string.IsNullOrWhiteSpace(input.Code) ? await _post.NextNumberAsync("SUPPLIER", "S") : input.Code.Trim(),
            Name = input.Name.Trim(), ContactPerson = input.ContactPerson, Phone = input.Phone, Address = input.Address, City = input.City,
            OpeningBalance = Money.R2(input.OpeningBalance), Notes = input.Notes, IsActive = input.IsActive
        };
        _db.Suppliers.Add(s);
        await _db.SaveChangesAsync();
        if (s.OpeningBalance != 0)
            _post.SupplierEntry(s.Id, "OPENING", Math.Max(-s.OpeningBalance, 0), Math.Max(s.OpeningBalance, 0), "Supplier", s.Id, DateTime.UtcNow, "Opening balance");
        _post.Audit("CREATE", "Supplier", s.Id, $"Supplier {s.Code} {s.Name}");
        return new { s.Id, s.Code };
    }));

    [HttpPut("{id:guid}"), Authorize(Policy = Perm.SuppliersManage)]
    public async Task<IActionResult> Update(Guid id, SupplierInput input)
    {
        var s = await _db.Suppliers.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Supplier");
        if (input.Version.HasValue && input.Version != s.Version) throw AppException.Conflict("This supplier was changed by someone else. Reload and try again.");
        s.Name = input.Name.Trim(); s.ContactPerson = input.ContactPerson; s.Phone = input.Phone; s.Address = input.Address; s.City = input.City;
        s.Notes = input.Notes; s.IsActive = input.IsActive; s.UpdatedAt = DateTime.UtcNow; s.Version++;
        _post.Audit("UPDATE", "Supplier", s.Id, $"Supplier {s.Code} updated");
        await _db.SaveChangesAsync();
        return NoContent();
    }
}

[ApiController, Route("api/customers"), Authorize(Policy = Perm.CustomersView)]
public class CustomersController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly CustomerService _customers;
    private readonly PostingService _post;
    public CustomersController(AppDbContext db, ICurrentUser user, CustomerService customers, PostingService post) { _db = db; _user = user; _customers = customers; _post = post; }

    [HttpGet]
    public async Task<IActionResult> List(string? q, string? area, Guid? routeId, int page = 1, int pageSize = 100)
    {
        pageSize = Math.Clamp(pageSize, 10, 500); page = Math.Max(1, page);
        var query = _db.Customers.Where(c => c.BusinessId == _user.BusinessId);
        if (!string.IsNullOrWhiteSpace(q))
            query = query.Where(c => EF.Functions.ILike(c.ShopName, $"%{q}%") || EF.Functions.ILike(c.Code, $"%{q}%") || (c.Phone != null && c.Phone.Contains(q))
                                   || (c.Area != null && EF.Functions.ILike(c.Area, $"%{q}%")) || (c.ContactPerson != null && EF.Functions.ILike(c.ContactPerson, $"%{q}%")));
        if (!string.IsNullOrWhiteSpace(area)) query = query.Where(c => c.Area == area);
        if (routeId.HasValue) query = query.Where(c => c.RouteId == routeId);
        var total = await query.CountAsync();
        var items = await query.OrderBy(c => c.ShopName).Skip((page - 1) * pageSize).Take(pageSize)
            .Select(c => new
            {
                c.Id, c.Code, c.ShopName, c.ContactPerson, c.Phone, c.WhatsApp, c.Address, c.Area, c.City, c.Latitude, c.Longitude, c.CustomerType,
                c.SalespersonId, c.RouteId, c.CreditLimit, c.PaymentTermsDays, c.OpeningBalance, c.Notes, c.IsActive, c.Version,
                balance = _db.CustomerLedgerEntries.Where(e => e.CustomerId == c.Id).Sum(e => (decimal?)(e.Debit - e.Credit)) ?? 0,
                lastInvoiceAt = _db.SalesInvoices.Where(i => i.CustomerId == c.Id && i.Status == "POSTED").Max(i => (DateTime?)i.InvoiceDate),
                lastVisitAt = _db.DeliveryStops.Where(s => s.CustomerId == c.Id).Max(s => s.VisitedAt)
            }).ToListAsync();
        return Ok(new { items, total, page, pageSize });
    }

    [HttpPost, Authorize(Policy = Perm.CustomersManage)]
    public async Task<IActionResult> Upsert(CustomerInput input) => Ok(await _post.InTransactionAsync(() => _customers.UpsertAsync(input)));
}

[ApiController, Route("api/routes"), Authorize]
public class RoutesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    public RoutesController(AppDbContext db, ICurrentUser user) { _db = db; _user = user; }

    public record RouteInput(string Name, string? Area, Guid? DefaultUserId, bool IsActive = true);

    [HttpGet] public async Task<IActionResult> List() => Ok(await _db.DeliveryRoutes.Where(r => r.BusinessId == _user.BusinessId).OrderBy(r => r.Name)
        .Select(r => new { r.Id, r.Name, r.Area, r.DefaultUserId, r.IsActive, customers = _db.Customers.Count(c => c.RouteId == r.Id) }).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.DeliveryManage)]
    public async Task<IActionResult> Create(RouteInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Route name is required.");
        var r = new DeliveryRoute { BusinessId = _user.BusinessId, Name = input.Name.Trim(), Area = input.Area, DefaultUserId = input.DefaultUserId, IsActive = input.IsActive };
        _db.DeliveryRoutes.Add(r);
        await _db.SaveChangesAsync();
        return Ok(new { r.Id });
    }

    [HttpPut("{id:guid}"), Authorize(Policy = Perm.DeliveryManage)]
    public async Task<IActionResult> Update(Guid id, RouteInput input)
    {
        var r = await _db.DeliveryRoutes.FirstOrDefaultAsync(x => x.Id == id && x.BusinessId == _user.BusinessId) ?? throw AppException.NotFound("Route");
        r.Name = input.Name.Trim(); r.Area = input.Area; r.DefaultUserId = input.DefaultUserId; r.IsActive = input.IsActive; r.UpdatedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return NoContent();
    }
}

[ApiController, Route("api/cash-accounts"), Authorize]
public class CashAccountsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly ICurrentUser _user;
    private readonly PostingService _post;
    public CashAccountsController(AppDbContext db, ICurrentUser user, PostingService post) { _db = db; _user = user; _post = post; }

    public record AccountInput(string Name, string? NameUr, string Kind, decimal OpeningBalance, bool IsActive = true);

    [HttpGet] public async Task<IActionResult> List() => Ok(await _db.CashAccounts.Where(a => a.BusinessId == _user.BusinessId).OrderBy(a => a.Kind).ThenBy(a => a.Name)
        .Select(a => new { a.Id, a.Name, a.NameUr, a.Kind, a.IsActive, a.OpeningBalance,
            balance = a.OpeningBalance + (_db.CashTransactions.Where(t => t.AccountId == a.Id).Sum(t => (decimal?)t.Amount) ?? 0) }).ToListAsync());

    [HttpPost, Authorize(Policy = Perm.SettingsManage)]
    public async Task<IActionResult> Create(AccountInput input)
    {
        var kind = Methods.Upper(input.Kind);
        if (!Methods.Payment.Contains(kind)) throw new AppException("bad_kind", "Kind must be CASH, BANK or WALLET.");
        if (string.IsNullOrWhiteSpace(input.Name)) throw new AppException("required", "Name is required.");
        var a = new CashAccount { BusinessId = _user.BusinessId, Name = input.Name.Trim(), NameUr = input.NameUr, Kind = kind, OpeningBalance = Money.R2(input.OpeningBalance), IsActive = input.IsActive };
        _db.CashAccounts.Add(a);
        _post.Audit("CREATE", "CashAccount", a.Id, $"Account {a.Name} ({kind}) opening {a.OpeningBalance:0.00}");
        await _db.SaveChangesAsync();
        return Ok(new { a.Id });
    }
}

/// <summary>Image and attachment upload. Files are validated by size and content signature, renamed, and served from /uploads.</summary>
[ApiController, Route("api/uploads"), Authorize]
public class UploadsController : ControllerBase
{
    private const long MaxBytes = 3 * 1024 * 1024;
    private readonly IWebHostEnvironment _env;
    private readonly IConfiguration _cfg;
    public UploadsController(IWebHostEnvironment env, IConfiguration cfg) { _env = env; _cfg = cfg; }

    [HttpPost("{kind}"), RequestSizeLimit(MaxBytes + 4096)]
    public async Task<IActionResult> Upload(string kind, IFormFile file)
    {
        if (kind is not ("products" or "logo" or "attachments")) throw new AppException("bad_kind", "Unknown upload type.");
        if (file == null || file.Length == 0) throw new AppException("no_file", "Choose a file to upload.");
        if (file.Length > MaxBytes) throw new AppException("too_large", "The file is larger than 3 MB.");

        var header = new byte[12];
        await using (var s = file.OpenReadStream()) { _ = await s.ReadAsync(header.AsMemory(0, header.Length)); }
        var ext = Sniff(header) ?? throw new AppException("bad_type", kind == "attachments" ? "Only JPG, PNG, WEBP or PDF files are allowed." : "Only JPG, PNG or WEBP images are allowed.");
        if (ext == ".pdf" && kind != "attachments") throw new AppException("bad_type", "Only images are allowed here.");

        var root = UploadRoot(_env, _cfg);
        var dir = Path.Combine(root, kind);
        Directory.CreateDirectory(dir);
        var name = $"{Guid.NewGuid():N}{ext}";
        await using (var fs = System.IO.File.Create(Path.Combine(dir, name))) { await file.CopyToAsync(fs); }
        return Ok(new { url = $"/uploads/{kind}/{name}" });
    }

    public static string UploadRoot(IWebHostEnvironment env, IConfiguration cfg) =>
        cfg["Uploads:Path"] is { Length: > 0 } p ? p : Path.Combine(env.ContentRootPath, "uploads");

    private static string? Sniff(byte[] h)
    {
        if (h[0] == 0xFF && h[1] == 0xD8 && h[2] == 0xFF) return ".jpg";
        if (h[0] == 0x89 && h[1] == 0x50 && h[2] == 0x4E && h[3] == 0x47) return ".png";
        if (h[0] == 0x52 && h[1] == 0x49 && h[2] == 0x46 && h[3] == 0x46 && h[8] == 0x57 && h[9] == 0x45 && h[10] == 0x42 && h[11] == 0x50) return ".webp";
        if (h[0] == 0x25 && h[1] == 0x50 && h[2] == 0x44 && h[3] == 0x46) return ".pdf";
        return null;
    }
}
