using System.Security.Cryptography;
using Dapper;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace SpiceErp.Api.Data;

/// <summary>
/// Applies database/schema.sql to an empty database, then numbered scripts in database/migrations
/// (e.g. 002_add_column.sql) whose number is above ApplicationSettings.SchemaVersion, then seeds the
/// first business, owner account and cash accounts. Optionally seeds a starter spice catalogue
/// (no stock, no transactions) when Seed:DemoCatalog = true.
/// </summary>
public static class DbInitializer
{
    public static async Task InitializeAsync(IServiceProvider services, IConfiguration cfg, ILogger log)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher<User>>();

        if (cfg.GetValue("Database:AutoInitialize", true))
        {
            await db.Database.OpenConnectionAsync();
            var conn = db.Database.GetDbConnection();
            var exists = await conn.ExecuteScalarAsync<bool>("SELECT to_regclass('public.\"Businesses\"') IS NOT NULL");
            var dir = Path.Combine(AppContext.BaseDirectory, "Database");
            if (!exists)
            {
                log.LogInformation("Empty database: applying schema.sql");
                await conn.ExecuteAsync(await File.ReadAllTextAsync(Path.Combine(dir, "schema.sql")), commandTimeout: 300);
            }

            var current = int.Parse(await conn.ExecuteScalarAsync<string>("SELECT \"Value\" FROM \"ApplicationSettings\" WHERE \"Key\" = 'SchemaVersion'") ?? "1");
            var migDir = Path.Combine(dir, "migrations");
            if (Directory.Exists(migDir))
            {
                foreach (var file in Directory.GetFiles(migDir, "*.sql").OrderBy(f => f))
                {
                    var name = Path.GetFileName(file);
                    if (!int.TryParse(name.Split('_')[0], out var version) || version <= current) continue;
                    log.LogInformation("Applying migration {Name}", name);
                    await using var tx = await conn.BeginTransactionAsync();
                    await conn.ExecuteAsync(await File.ReadAllTextAsync(file), transaction: tx, commandTimeout: 300);
                    await conn.ExecuteAsync("UPDATE \"ApplicationSettings\" SET \"Value\" = @v WHERE \"Key\" = 'SchemaVersion'", new { v = version.ToString() }, tx);
                    await tx.CommitAsync();
                    current = version;
                }
            }
            await db.Database.CloseConnectionAsync();
        }

        if (await db.Businesses.AnyAsync()) return;

        log.LogInformation("Seeding first business and owner account");
        var business = new Business
        {
            Name = cfg["Seed:BusinessName"] ?? "My Spice Company",
            NameUr = cfg["Seed:BusinessNameUr"] ?? "میری مصالحہ کمپنی",
            Phone = cfg["Seed:BusinessPhone"],
            Address = cfg["Seed:BusinessAddress"] ?? "Lahore, Pakistan",
            InvoiceTerms = "Goods once sold can be returned within 7 days in original condition.",
            InvoiceTermsUr = "فروخت شدہ مال اصل حالت میں 7 دن کے اندر واپس ہو سکتا ہے۔"
        };
        db.Businesses.Add(business);
        await db.SaveChangesAsync();

        var username = cfg["Seed:AdminUsername"] ?? "admin";
        var password = cfg["Seed:AdminPassword"];
        var generated = string.IsNullOrWhiteSpace(password);
        if (generated) password = "Sp" + Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant() + "9";

        var owner = new User { BusinessId = business.Id, Username = username, FullName = cfg["Seed:AdminFullName"] ?? "Owner" };
        owner.PasswordHash = hasher.HashPassword(owner, password!);
        owner.Roles.Add(new UserRole { UserId = owner.Id, RoleCode = "Owner" });
        db.Users.Add(owner);

        db.CashAccounts.AddRange(
            new CashAccount { BusinessId = business.Id, Name = "Cash in Hand", NameUr = "نقد رقم", Kind = "CASH" },
            new CashAccount { BusinessId = business.Id, Name = "Bank Account", NameUr = "بینک اکاؤنٹ", Kind = "BANK" },
            new CashAccount { BusinessId = business.Id, Name = "Mobile Wallet", NameUr = "موبائل والٹ", Kind = "WALLET" });
        await db.SaveChangesAsync();

        if (generated)
            log.LogWarning("==== OWNER ACCOUNT CREATED: username '{User}' password '{Password}' — change it after first sign-in ====", username, password);
        else
            log.LogInformation("Owner account '{User}' created from configuration.", username);

        if (cfg.GetValue("Seed:DemoCatalog", false)) await SeedCatalogAsync(db, business.Id);
    }

    private static async Task SeedCatalogAsync(AppDbContext db, Guid businessId)
    {
        var ground = new ProductCategory { BusinessId = businessId, Name = "Ground Spices", NameUr = "پسے ہوئے مصالحے" };
        var blends = new ProductCategory { BusinessId = businessId, Name = "Blended Masala", NameUr = "مکس مصالحہ" };
        db.ProductCategories.AddRange(ground, blends);

        int[] sizes = { 20, 50, 100, 200 };
        var pouches = sizes.ToDictionary(s => s, s => new PackagingMaterial
        {
            BusinessId = businessId, Code = $"POUCH-{s}", Name = $"Pouch {s} g", NameUr = $"پاؤچ {s} گرام", Kind = "POUCH", MinStock = 500
        });
        var label = new PackagingMaterial { BusinessId = businessId, Code = "LABEL-STD", Name = "Printed label", NameUr = "پرنٹ شدہ لیبل", Kind = "LABEL", MinStock = 1000 };
        db.PackagingMaterials.AddRange(pouches.Values);
        db.PackagingMaterials.Add(label);
        await db.SaveChangesAsync();

        var spices = new (string code, string name, string ur, string type, ProductCategory cat)[]
        {
            ("BP", "Black Pepper Powder", "کالی مرچ پاؤڈر", "Black pepper", ground),
            ("TU", "Turmeric Powder", "ہلدی پاؤڈر", "Turmeric", ground),
            ("RC", "Red Chilli Powder", "لال مرچ پاؤڈر", "Red chilli", ground),
            ("CO", "Coriander Powder", "دھنیا پاؤڈر", "Coriander", ground),
            ("CU", "Cumin Powder", "زیرہ پاؤڈر", "Cumin", ground),
            ("GM", "Garam Masala", "گرم مصالحہ", "Blend", blends),
            ("CM", "Chat Masala", "چاٹ مصالحہ", "Blend", blends),
        };
        foreach (var s in spices)
        {
            var p = new Product
            {
                BusinessId = businessId, CategoryId = s.cat.Id, Code = s.code, Name = s.name, NameUr = s.ur, SpiceType = s.type,
                MinStockGrams = 5000, ReorderGrams = 25000
            };
            foreach (var g in sizes)
            {
                // Starter prices only (Rs. 1 per gram retail, 10% wholesale discount). Change them under Products.
                p.Variations.Add(new ProductVariation
                {
                    BusinessId = businessId, ProductId = p.Id, Sku = $"{s.code}-{g}", PacketGrams = g, RetailPrice = g,
                    WholesalePrice = Math.Round(g * 0.9m, 2), PouchMaterialId = pouches[g].Id, LabelMaterialId = label.Id, MinStockPackets = 20
                });
            }
            db.Products.Add(p);
        }
        await db.SaveChangesAsync();
    }
}
