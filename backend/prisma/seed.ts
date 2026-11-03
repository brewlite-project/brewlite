/**
 * BrewLite API Contract v2.1 demo product seed.
 * Source names/image links: danh_s_ch_s_n_ph_m_ng_d_n_nh.md.
 * Price, stock, categories, badges, topping eligibility: suggested DEMO data.
 * Strict nine-product catalog: refuses to run if any other products exist.
 * Never deletes legacy products or touches orders.
 * Download images into frontend/public/images before running frontend.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

export function isSeedDatabaseAllowed(
  databaseUrl: string,
  allowComposeDemoSeed = process.env.ALLOW_COMPOSE_DEMO_SEED,
): boolean {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const isDedicatedSeedDatabase = /^brewlite_seed_[a-z0-9_]+$/i.test(databaseName);
  const isApprovedComposeDatabase =
    databaseName === "brewlite_compose" &&
    url.hostname === "postgres" &&
    url.port === "5432" &&
    allowComposeDemoSeed === "true";

  return isDedicatedSeedDatabase || isApprovedComposeDatabase;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    typeof entrypoint === "string" &&
    import.meta.url === pathToFileURL(resolve(entrypoint)).href
  );
}

const categories = [
  { code: "traditional", name: "Cà phê truyền thống" },
  { code: "espresso_coldbrew", name: "Espresso & Cold Brew" },
  { code: "tea_macchiato", name: "Trà & Macchiato" },
  { code: "bakery", name: "Bánh ngọt" },
] as const;

// Prices and stocks are example values; confirm before release.
// Deliberately use NEW IDs to avoid rewriting products referenced by past orders.
const products = [
  { id: "a3000000-0000-4000-8000-000000000001", name: "Bạc Xỉu Kem Béo Phin", categoryCode: "traditional", price: 42000, stock: 25, image: "bac-xiu-kem-beo-phin", sizePolicy: "STANDARD", isNew: false, isBestseller: true, toppingCodes: ["CHEESE_FOAM", "WHIPPED_CREAM", "EXTRA_SHOT"] },
  { id: "a3000000-0000-4000-8000-000000000002", name: "Cà Phê Đen Đá Cầu Đất", categoryCode: "traditional", price: 32000, stock: 30, image: "ca-phe-den-da-cau-dat", sizePolicy: "STANDARD", isNew: false, isBestseller: true, toppingCodes: ["EXTRA_SHOT"] },
  { id: "a3000000-0000-4000-8000-000000000003", name: "Cà Phê Muối Cố Đô", categoryCode: "traditional", price: 39000, stock: 20, image: "ca-phe-muoi-co-do", sizePolicy: "STANDARD", isNew: true, isBestseller: false, toppingCodes: ["CHEESE_FOAM", "EXTRA_SHOT"] },
  { id: "a3000000-0000-4000-8000-000000000004", name: "Cà phê Sữa Đá Sài Gòn", categoryCode: "traditional", price: 35000, stock: 28, image: "ca-phe-sua-da-sai-gon", sizePolicy: "STANDARD", isNew: false, isBestseller: true, toppingCodes: ["EXTRA_SHOT", "WHIPPED_CREAM"] },
  { id: "a3000000-0000-4000-8000-000000000005", name: "Cold Brew Cam Sả Thảo Mộc", categoryCode: "espresso_coldbrew", price: 49000, stock: 18, image: "cold-brew-cam-sa-thao-moc", sizePolicy: "STANDARD", isNew: true, isBestseller: false, toppingCodes: ["EXTRA_SHOT"] },
  { id: "a3000000-0000-4000-8000-000000000006", name: "Cold Brew Vải Hoa Hồng", categoryCode: "espresso_coldbrew", price: 52000, stock: 16, image: "cold-brew-vai-hoa-hong", sizePolicy: "STANDARD", isNew: true, isBestseller: false, toppingCodes: [] },
  { id: "a3000000-0000-4000-8000-000000000007", name: "Espresso Macchiato Caramel", categoryCode: "espresso_coldbrew", price: 45000, stock: 22, image: "espresso-macchiato-caramel", sizePolicy: "STANDARD", isNew: false, isBestseller: false, toppingCodes: ["WHIPPED_CREAM", "EXTRA_SHOT"] },
  { id: "a3000000-0000-4000-8000-000000000008", name: "Trà Đào Cam Sả Hoàng Gia", categoryCode: "tea_macchiato", price: 46000, stock: 24, image: "tra-dao-cam-sa-hoang-gia", sizePolicy: "STANDARD", isNew: false, isBestseller: true, toppingCodes: ["GRASS_JELLY", "PEARL"] },
  { id: "a3000000-0000-4000-8000-000000000009", name: "Croissant Bơ Pháp Nướng", categoryCode: "bakery", price: 38000, stock: 15, image: "croissant-bo-phap-nuong", sizePolicy: "ONE_SIZE", isNew: true, isBestseller: false, toppingCodes: [] },
] as const;

const toppings = [
  { id: "b2000000-0000-4000-8000-000000000001", code: "PEARL", name: "Trân châu", price: 5000 },
  { id: "b2000000-0000-4000-8000-000000000002", code: "CHEESE_FOAM", name: "Kem cheese", price: 10000 },
  { id: "b2000000-0000-4000-8000-000000000003", code: "EXTRA_SHOT", name: "Thêm shot espresso", price: 12000 },
  { id: "b2000000-0000-4000-8000-000000000004", code: "GRASS_JELLY", name: "Sương sáo", price: 5000 },
  { id: "b2000000-0000-4000-8000-000000000005", code: "WHIPPED_CREAM", name: "Kem tươi", price: 8000 },
] as const;

async function main(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    const wantedIds = products.map((product) => product.id);
    const otherProducts = await tx.product.findMany({
      where: { id: { notIn: wantedIds } },
      select: { id: true, name: true },
      take: 5,
    });
    if (otherProducts.length > 0) {
      throw new Error(
        `Database already contains legacy/unlisted products (sample: ${otherProducts.map((p) => p.name).join(", ")}). ` +
        `Refusing to seed a catalog that must contain only 9 products. Use a clean brewlite_seed_* DB; do not delete products referenced by orders.`,
      );
    }
    const categoryIds = new Map<string, string>();
    for (const category of categories) {
      const row = await tx.category.upsert({
        where: { code: category.code },
        create: { ...category, isActive: true },
        update: { name: category.name }, // preserve manually deactivated categories
      });
      categoryIds.set(category.code, row.id);
    }
    const toppingIds = new Map<string, string>();
    for (const topping of toppings) {
      const row = await tx.topping.upsert({
        where: { code: topping.code },
        create: { id: topping.id, code: topping.code, name: topping.name, priceVnd: BigInt(topping.price), isAvailable: true },
        update: { name: topping.name, priceVnd: BigInt(topping.price) }, // preserve availability
      });
      toppingIds.set(topping.code, row.id);
    }
    for (const product of products) {
      const categoryId = categoryIds.get(product.categoryCode);
      if (!categoryId) throw new Error(`Missing category ${product.categoryCode}`);
      const data = {
        name: product.name,
        categoryId,
        description: null,
        basePriceVnd: BigInt(product.price),
        imageUrl: `/images/${product.image}.jpg`,
        sizePolicy: product.sizePolicy === "ONE_SIZE" ? ("ONE_SIZE" as const) : ("STANDARD" as const),
        isNew: product.isNew,
        isBestseller: product.isBestseller,
        rating: null,
      };
      await tx.product.upsert({
        where: { id: product.id },
        create: { id: product.id, ...data, stock: product.stock },
        update: data, // Preserve stock on reruns (do not reset inventory).
      });
      for (const code of product.toppingCodes) {
        const toppingId = toppingIds.get(code);
        if (!toppingId) throw new Error(`Missing topping ${code}`);
        await tx.productTopping.upsert({
          where: { productId_toppingId: { productId: product.id, toppingId } },
          create: { productId: product.id, toppingId },
          update: {},
        });
      }
    }
  });
  console.log(`Seed completed: ${products.length} menu products, ${toppings.length} toppings; no legacy products present.`);
}

if (isMainModule()) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");

  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  // Preserve dedicated brewlite_seed_* databases. Compose needs all four exact
  // conditions in isSeedDatabaseAllowed; never broaden this to a wildcard.
  if (!isSeedDatabaseAllowed(databaseUrl)) {
    throw new Error(`Seeding is not allowed for database: ${databaseName}`);
  }

  // Run on a dedicated clean test or explicitly approved Compose database only.
  // Legacy products may be referenced by orders; the strict check below never
  // silently deletes or deactivates them.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  main(prisma)
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
