import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import { pathToFileURL } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PaymentFailedRetryView } from "../components/PaymentFailedRetryView";
import { CartProvider, useCart, clearStoredActiveOrder } from "../context/CartContext";
import {
  type OrderConfirmationData,
  findOrderForConfirmation,
  fetchMyOrdersApi,
  submitRetryPaymentApi,
  generateIdempotencyKey,
  fetchAuthMeProfile,
} from "../services/order-confirmation.service";
import { createOrderApi } from "../services/order.service";
import { registerApi, loginApi, validateJwtToken } from "../services/auth.service";
import type {
  CreateOrderRequestDto,
  CreateOrderResponseDto,
  OrderStatus,
  PaymentResponseDto,
} from "../mock-data";
import {
  executePaymentSubmission,
  type ExecutePaymentSubmissionDeps,
} from "../components/PaymentPageView";

const NATIVE_FETCH = globalThis.fetch;

interface RealPrismaModelDelegate {
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findUniqueOrThrow(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

interface RealPrismaService {
  category: RealPrismaModelDelegate;
  product: RealPrismaModelDelegate;
  topping: RealPrismaModelDelegate;
  productTopping: RealPrismaModelDelegate;
  coupon: RealPrismaModelDelegate;
  couponRedemption: RealPrismaModelDelegate;
  user: RealPrismaModelDelegate;
  order: RealPrismaModelDelegate;
  orderItem: RealPrismaModelDelegate;
  orderItemTopping: RealPrismaModelDelegate;
  payment: RealPrismaModelDelegate;
}

interface RealNestApp {
  listen(port: number, hostname?: string): Promise<unknown>;
  close(): Promise<void>;
  get<T>(token: unknown): T;
}

function createValidMockJwt(
  sub = "550e8400-e29b-41d4-a716-446655440001",
  expiresInSeconds = 3600
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  ).toString("base64url");
  return `${header}.${payload}.mockSignature123`;
}

describe("SCRUM-69: End-to-End Payment & Confirmation Flow Integration Tests", () => {
  let dom: JSDOM;
  let originalWindow: unknown;
  let originalDocument: unknown;
  let originalSelf: unknown;
  let originalLocalStorage: unknown;
  let originalSessionStorage: unknown;
  let globalTarget: {
    window: unknown;
    document: unknown;
    self: unknown;
    localStorage: unknown;
    sessionStorage: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  let originalActEnv: boolean | undefined;

  const CART_KEY = "brewlite_cart_v1";

  const setupDom = () => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
      url: "http://localhost/order-confirmation?orderId=550e8400-e29b-41d4-a716-446655440010",
    });
    globalTarget = globalThis as unknown as typeof globalTarget;
    originalWindow = globalTarget.window;
    originalDocument = globalTarget.document;
    originalSelf = globalTarget.self;
    originalLocalStorage = globalTarget.localStorage;
    originalSessionStorage = globalTarget.sessionStorage;
    originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

    globalTarget.window = dom.window;
    globalTarget.document = dom.window.document;
    globalTarget.self = dom.window;
    globalTarget.localStorage = dom.window.localStorage;
    globalTarget.sessionStorage = dom.window.sessionStorage;
    globalTarget.IS_REACT_ACT_ENVIRONMENT = true;
  };

  const cleanupDom = () => {
    globalTarget.window = originalWindow;
    globalTarget.document = originalDocument;
    globalTarget.self = originalSelf;
    globalTarget.localStorage = originalLocalStorage;
    globalTarget.sessionStorage = originalSessionStorage;
    globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
    dom.window.close();
  };

  const createSampleCartItem = (productId = "550e8400-e29b-41d4-a716-446655440001") => ({
    id: "cart-item-e2e-1",
    productId,
    productName: "Cà phê Sữa Đá",
    size: "M",
    sizeMultiplierPercent: 120,
    basePriceVnd: 35000,
    quantity: 2,
    unitPriceVnd: 42000,
    lineTotalVnd: 84000,
    toppings: [],
  });

  const createSampleOrder = (
    status: OrderStatus = "PENDING",
    overrides: Partial<OrderConfirmationData> = {}
  ): OrderConfirmationData => ({
    id: "550e8400-e29b-41d4-a716-446655440010",
    status,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
    subtotalVnd: 70000,
    discountVnd: 0,
    totalVnd: 70000,
    couponCode: null,
    pointsEarned: status === "PAID" ? 7 : 0,
    payment:
      status === "PAID"
        ? {
            id: "550e8400-e29b-41d4-a716-446655440077",
            method: "CARD",
            methodLast4: "1234",
            mockReference: "MOCK-REF-1234",
            amountVnd: 70000,
            status: "SUCCESS",
            failureReason: null,
            createdAt: new Date().toISOString(),
          }
        : null,
    items: [
      {
        id: "550e8400-e29b-41d4-a716-446655440011",
        productId: "550e8400-e29b-41d4-a716-446655440001",
        productName: "Cà phê Sữa Đá",
        size: "M",
        sizeMultiplierPercent: 100,
        basePriceVnd: 35000,
        quantity: 2,
        unitPriceVnd: 35000,
        lineTotalVnd: 70000,
        toppings: [],
      },
    ],
    ...overrides,
  });

  // ==========================================================================
  // REAL NESTJS BACKEND + DISPOSABLE POSTGRESQL TEST DB E2E VERIFICATION
  // - KHÔNG mock `fetch` (giữ nguyên `NATIVE_FETCH` 100%)
  // - KHÔNG fake response lifecycle
  // - Dùng PostgreSQL test DB riêng (`brewlite_scrum69_test_db`), KHÔNG đụng DB dev
  // - JWT đi qua `/auth/register` & `/auth/login` thật của NestJS Backend
  // - Xác minh dữ liệu `Order`, `Payment`, `CouponRedemption`, `User` thực sự persist trong PostgreSQL
  // ==========================================================================
  describe("0. Real NestJS Backend + PostgreSQL Test DB Integration Verification (No fetch mock)", () => {
    let app: RealNestApp | undefined;
    let prisma: RealPrismaService | undefined;
    let originalDbUrl: string | undefined;
    const runId = randomUUID();
    const categoryId = randomUUID();
    const productId = randomUUID();
    const toppingId = randomUUID();
    const createdUserIds: string[] = [];
    const createdCouponIds: string[] = [];

    before(async () => {
      globalThis.fetch = NATIVE_FETCH;

      const backendDir = path.resolve(process.cwd(), "../backend");
      const backendRequire = createRequire(path.join(backendDir, "package.json"));
      backendRequire("reflect-metadata");
      const dotenv = backendRequire("dotenv") as {
        config(opts: { path: string }): void;
      };
      dotenv.config({ path: path.join(backendDir, ".env") });

      originalDbUrl = process.env.DATABASE_URL;
      const rawBaseUrl =
        process.env.ORDERS_TEST_DATABASE_URL ||
        process.env.AUTH_TEST_DATABASE_URL ||
        process.env.DATABASE_URL;

      if (!rawBaseUrl) {
        throw new Error(
          "Missing DATABASE_URL or ORDERS_TEST_DATABASE_URL for SCRUM-69 real PostgreSQL integration test."
        );
      }

      // Luôn ép buộc dùng disposable PostgreSQL test DB riêng biệt `brewlite_scrum69_test_db`
      // Tuyệt đối không ghi hay reset trên DB dev (`brewlite_db` / `brewlite_seed_catalog_v21`).
      const dbUrlObj = new URL(rawBaseUrl);
      const testDbName = "brewlite_scrum69_test_db";

      const { Client } = backendRequire("pg") as {
        Client: new (opts: { connectionString: string }) => {
          connect(): Promise<void>;
          query(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
          end(): Promise<void>;
        };
      };
      const adminClient = new Client({ connectionString: rawBaseUrl });
      await adminClient.connect();
      try {
        const exists = await adminClient.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [testDbName]
        );
        if (exists.rowCount === 0) {
          await adminClient.query(`CREATE DATABASE ${testDbName}`);
          const { execSync } = backendRequire("node:child_process") as typeof import("node:child_process");
          const tempUrl = new URL(rawBaseUrl);
          tempUrl.pathname = `/${testDbName}`;
          execSync("npx prisma migrate deploy --config prisma7.config.ts", {
            cwd: backendDir,
            env: { ...process.env, DATABASE_URL: tempUrl.toString() },
            stdio: "ignore",
          });
        }
      } finally {
        await adminClient.end();
      }

      dbUrlObj.pathname = `/${testDbName}`;
      process.env.DATABASE_URL = dbUrlObj.toString();
      process.env.JWT_SECRET =
        process.env.JWT_SECRET || "brewlite-test-only-secret-at-least-32-bytes";
      process.env.ORDER_EXPIRATION_ENABLED = "false";
      process.env.PAYMENT_RECONCILIATION_ENABLED = "false";
      process.env.MOCK_PAYMENT_ENABLED = "true";

      const { NestFactory } = backendRequire("@nestjs/core") as {
        NestFactory: {
          create(moduleCls: unknown, opts?: Record<string, unknown>): Promise<RealNestApp>;
        };
      };
      const { AppModule } = (await import(
        pathToFileURL(path.join(backendDir, "dist/app.module.js")).href
      )) as { AppModule: unknown };
      const { PrismaService } = (await import(
        pathToFileURL(path.join(backendDir, "dist/prisma/prisma.service.js")).href
      )) as { PrismaService: unknown };

      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(3001, "127.0.0.1");
      prisma = app.get<RealPrismaService>(PrismaService);

      // Tạo danh mục, sản phẩm và topping thật trong disposable PostgreSQL test DB
      await prisma.category.create({
        data: {
          id: categoryId,
          code: `scrum69-cat-${runId.slice(0, 12)}`,
          name: "SCRUM-69 Real Test Category",
          isActive: true,
        },
      });

      await prisma.product.create({
        data: {
          id: productId,
          categoryId,
          name: "Cà phê Sữa Đá SCRUM-69",
          basePriceVnd: BigInt(35000),
          imageUrl: "/images/product-placeholder.svg",
          stock: 50,
          sizePolicy: "STANDARD",
        },
      });

      await prisma.topping.create({
        data: {
          id: toppingId,
          code: `scrum69-top-${runId.slice(0, 12)}`,
          name: "Trân châu trắng",
          priceVnd: BigInt(5000),
          isAvailable: true,
        },
      });

      await prisma.productTopping.create({
        data: {
          productId,
          toppingId,
        },
      });
    });

    after(async () => {
      try {
        if (prisma) {
          if (createdUserIds.length > 0) {
            const whereUser = { userId: { in: createdUserIds } };
            await prisma.payment.deleteMany({ where: whereUser });
            await prisma.couponRedemption.deleteMany({ where: whereUser });
            await prisma.orderItemTopping.deleteMany({
              where: { orderItem: { order: whereUser } },
            });
            await prisma.orderItem.deleteMany({
              where: { order: whereUser },
            });
            await prisma.order.deleteMany({ where: whereUser });
            await prisma.user.deleteMany({
              where: { id: { in: createdUserIds } },
            });
          }
          if (createdCouponIds.length > 0) {
            await prisma.coupon.deleteMany({
              where: { id: { in: createdCouponIds } },
            });
          }
          await prisma.productTopping.deleteMany({ where: { productId } });
          await prisma.topping.deleteMany({ where: { id: toppingId } });
          await prisma.product.deleteMany({ where: { id: productId } });
          await prisma.category.deleteMany({ where: { id: categoryId } });
        }
      } finally {
        if (app) {
          await app.close();
        }
        if (originalDbUrl !== undefined) {
          process.env.DATABASE_URL = originalDbUrl;
        }
      }
    });

    it("Flow 1 (Real Backend + PostgreSQL): Happy Path — Real JWT -> POST /orders (PENDING) -> POST /payments (SUCCESS -> PAID) -> GET /orders/me -> DB Persistence verified", async () => {
      assert.strictEqual(
        globalThis.fetch,
        NATIVE_FETCH,
        "globalThis.fetch MUST be native unmocked fetch for real E2E verification"
      );
      assert.ok(prisma, "PrismaService must be initialized");

      // 1. Tạo tài khoản và đăng nhập thật qua NestJS AuthController + Argon2 + PostgreSQL
      const email = `scrum69-happy-${randomUUID()}@brewlite.test`;
      const password = "RealPassword123!";
      const registeredUser = await registerApi({
        email,
        password,
        fullName: "Khách Hàng Thật SCRUM-69",
      });
      createdUserIds.push(registeredUser.id);

      const loginResponse = await loginApi({ email, password });
      const realJwt = loginResponse.accessToken;
      const decodedJwt = validateJwtToken(realJwt);
      assert.equal(decodedJwt.sub, registeredUser.id);

      // Tạo mã giảm giá thật trong PostgreSQL để kiểm chứng cả tính toán giảm giá & CouponRedemption
      const couponId = randomUUID();
      const couponCode = `S69HAPPY${couponId.replaceAll("-", "").slice(0, 10)}`.toUpperCase();
      createdCouponIds.push(couponId);
      await prisma.coupon.create({
        data: {
          id: couponId,
          code: couponCode,
          type: "FIXED",
          value: 10000,
          startsAt: new Date(Date.now() - 60000),
          expiresAt: new Date(Date.now() + 3600000),
          usageLimit: 10,
          perUserLimit: 1,
        },
      });

      // 2. Gọi POST /orders thật qua Frontend `createOrderApi` (không mock fetch)
      // Size M (120% của 35,000 = 42,000) + 1 topping (5,000) = 47,000 / ly * 2 ly = 94,000 VND
      // Giảm giá 10,000 VND -> totalVnd = 84,000 VND (pointsEarned khi PAID = floor(84,000 / 10,000) = 8)
      const checkoutPayload: CreateOrderRequestDto = {
        couponCode,
        items: [
          {
            productId,
            size: "M",
            quantity: 2,
            toppingIds: [toppingId],
          },
        ],
      };

      const createdOrder = await createOrderApi(checkoutPayload, realJwt);
      assert.equal(createdOrder.status, "PENDING");
      assert.equal(createdOrder.subtotalVnd, 94000);
      assert.equal(createdOrder.discountVnd, 10000);
      assert.equal(createdOrder.totalVnd, 84000);
      assert.equal(createdOrder.couponCode, couponCode);
      assert.equal(createdOrder.items.length, 1);
      assert.equal(createdOrder.items[0].unitPriceVnd, 47000);
      assert.equal(createdOrder.items[0].lineTotalVnd, 94000);

      // Kiểm chứng Order PENDING đã thực sự persist trong PostgreSQL test DB
      const dbOrderPending = await prisma.order.findUniqueOrThrow({
        where: { id: createdOrder.id },
        include: { items: true, couponRedemption: true },
      });
      assert.equal(dbOrderPending.status, "PENDING");
      assert.equal(dbOrderPending.userId, registeredUser.id);
      assert.equal(Number(dbOrderPending.subtotalVnd), 94000);
      assert.equal(Number(dbOrderPending.discountVnd), 10000);
      assert.equal(Number(dbOrderPending.totalVnd), 84000);
      assert.equal(
        (dbOrderPending.couponRedemption as Record<string, unknown>)?.status,
        "HELD"
      );

      // 3. Gọi POST /payments thật qua Frontend `executePaymentSubmission` (không mock fetch)
      let cartClearedCount = 0;
      let pointsEarnedCallback = 0;
      let paymentResultDto: PaymentResponseDto | null = null;
      const idempotencyKey = generateIdempotencyKey();

      const paymentDeps: ExecutePaymentSubmissionDeps = {
        activeOrder: createdOrder,
        orderStatus: "PENDING",
        payload: {
          orderId: createdOrder.id,
          method: "CARD",
          paymentDetails: { cardNumber: "1234567890121234" },
        },
        idempotencyKey,
        accessToken: realJwt,
        isAuthenticated: true,
        verifySession: () => true,
        openAuthModal: () => {},
        submittingRef: { current: false },
        isSubmitting: false,
        setIsSubmitting: () => {},
        setIdempotencyKey: () => {},
        setPaymentResult: (res) => {
          paymentResultDto = res;
        },
        setOrderStatus: () => {},
        setPaymentError: () => {},
        clearCart: () => {
          cartClearedCount += 1;
        },
        onPointsEarned: (pts) => {
          pointsEarnedCallback += pts;
        },
      };

      const submissionResult = await executePaymentSubmission(paymentDeps);
      assert.equal(submissionResult.skipped, false);
      assert.ok(submissionResult.outcome);
      assert.equal(submissionResult.outcome.type, "success");
      assert.ok(paymentResultDto !== null);

      const verifiedPayment = paymentResultDto as PaymentResponseDto;
      assert.equal(verifiedPayment.orderId, createdOrder.id);
      assert.equal(verifiedPayment.paymentStatus, "SUCCESS");
      assert.equal(verifiedPayment.orderStatus, "PAID");
      assert.equal(verifiedPayment.amountVnd, 84000);
      assert.equal(verifiedPayment.method, "CARD");
      assert.equal(verifiedPayment.methodLast4, "1234");
      assert.equal(verifiedPayment.pointsEarned, 8);
      assert.equal(verifiedPayment.failureReason, null);
      assert.equal(cartClearedCount, 1, "Cart phải được xóa đúng 1 lần sau khi POST /payments trả SUCCESS");
      assert.equal(pointsEarnedCallback, 8);

      // 4. Gọi GET /orders/me thật và GET /auth/me thật qua Frontend service (không mock fetch)
      const myOrders = await fetchMyOrdersApi(realJwt);
      const confirmedOrder = findOrderForConfirmation(myOrders, createdOrder.id);
      assert.ok(confirmedOrder !== null, "GET /orders/me phải trả về đơn hàng vừa thanh toán");
      assert.equal(confirmedOrder.id, createdOrder.id);
      assert.equal(confirmedOrder.status, "PAID");
      assert.equal(confirmedOrder.subtotalVnd, 94000);
      assert.equal(confirmedOrder.discountVnd, 10000);
      assert.equal(confirmedOrder.totalVnd, 84000);
      assert.equal(confirmedOrder.pointsEarned, 8);
      assert.ok(confirmedOrder.payment !== null);
      assert.equal(confirmedOrder.payment.id, verifiedPayment.paymentId);
      assert.equal(confirmedOrder.payment.status, "SUCCESS");
      assert.equal(confirmedOrder.payment.method, "CARD");
      assert.equal(confirmedOrder.payment.methodLast4, "1234");
      assert.equal(confirmedOrder.payment.amountVnd, 84000);
      assert.equal(confirmedOrder.payment.failureReason, null);

      const meProfile = await fetchAuthMeProfile(realJwt);
      assert.ok(meProfile !== null);
      assert.equal(meProfile.id, registeredUser.id);
      assert.equal(meProfile.loyaltyPoints, 8);

      // 5. Xác nhận trực tiếp trong PostgreSQL test DB rằng Order, Payment, CouponRedemption và User đã persist chuẩn xác
      const dbOrderPaid = await prisma.order.findUniqueOrThrow({
        where: { id: createdOrder.id },
        include: { payments: true, couponRedemption: true },
      });
      assert.equal(dbOrderPaid.status, "PAID");
      assert.equal(dbOrderPaid.pointsEarned, 8);
      assert.equal(
        (dbOrderPaid.couponRedemption as Record<string, unknown>)?.status,
        "CONSUMED"
      );

      const dbPayments = dbOrderPaid.payments as Array<Record<string, unknown>>;
      assert.equal(dbPayments.length, 1);
      assert.equal(dbPayments[0].id, verifiedPayment.paymentId);
      assert.equal(dbPayments[0].status, "SUCCESS");
      assert.equal(dbPayments[0].method, "CARD");
      assert.equal(dbPayments[0].methodLast4, "1234");
      assert.equal(Number(dbPayments[0].amountVnd), 84000);
      assert.equal(dbPayments[0].idempotencyKey, idempotencyKey);

      const dbUser = await prisma.user.findUniqueOrThrow({
        where: { id: registeredUser.id },
      });
      assert.equal(dbUser.loyaltyPoints, 8);
    });

    it("Flow 2 (Real Backend + PostgreSQL): FAILED -> Retry with new Idempotency-Key -> SUCCESS -> GET /orders/me & DB Persistence verified", async () => {
      assert.strictEqual(
        globalThis.fetch,
        NATIVE_FETCH,
        "globalThis.fetch MUST be native unmocked fetch for real E2E verification"
      );
      assert.ok(prisma, "PrismaService must be initialized");

      // 1. Đăng ký và đăng nhập tài khoản mới thật trên Backend
      const email = `scrum69-retry-${randomUUID()}@brewlite.test`;
      const password = "RealPassword123!";
      const registeredUser = await registerApi({
        email,
        password,
        fullName: "Khách Hàng Retry SCRUM-69",
      });
      createdUserIds.push(registeredUser.id);

      const loginResponse = await loginApi({ email, password });
      const realJwt = loginResponse.accessToken;

      // 2. Tạo Order thật qua POST /orders (Size S = 100% * 35,000 * 2 ly = 70,000 VND)
      const createdOrder = await createOrderApi(
        {
          items: [
            {
              productId,
              size: "S",
              quantity: 2,
              toppingIds: [],
            },
          ],
        },
        realJwt
      );
      assert.equal(createdOrder.status, "PENDING");
      assert.equal(createdOrder.totalVnd, 70000);

      // 3. Lần thanh toán đầu tiên: Gửi thẻ đuôi 0002 -> Backend thật trả HTTP 200 FAILED (PAYMENT_DECLINED)
      const firstKey = generateIdempotencyKey();
      let cartClearedOnFirstAttempt = false;
      let rotatedKeyFromFirstAttempt = "";

      const firstDeps: ExecutePaymentSubmissionDeps = {
        activeOrder: createdOrder,
        orderStatus: "PENDING",
        payload: {
          orderId: createdOrder.id,
          method: "CARD",
          paymentDetails: { cardNumber: "1234567890120002" },
        },
        idempotencyKey: firstKey,
        accessToken: realJwt,
        isAuthenticated: true,
        verifySession: () => true,
        openAuthModal: () => {},
        submittingRef: { current: false },
        isSubmitting: false,
        setIsSubmitting: () => {},
        setIdempotencyKey: (k) => {
          rotatedKeyFromFirstAttempt = k;
        },
        setPaymentResult: () => {},
        setOrderStatus: () => {},
        setPaymentError: () => {},
        clearCart: () => {
          cartClearedOnFirstAttempt = true;
        },
      };

      const firstAttempt = await executePaymentSubmission(firstDeps);
      assert.ok(firstAttempt.outcome);
      assert.equal(firstAttempt.outcome.type, "failed");
      assert.equal(firstAttempt.outcome.response.paymentStatus, "FAILED");
      assert.equal(firstAttempt.outcome.response.orderStatus, "PAYMENT_FAILED");
      assert.equal(firstAttempt.outcome.response.failureReason, "PAYMENT_DECLINED");
      assert.equal(firstAttempt.outcome.response.pointsEarned, 0);
      assert.equal(
        cartClearedOnFirstAttempt,
        false,
        "Cart TUYỆT ĐỐI KHÔNG được xóa khi lần thanh toán đầu FAILED"
      );
      assert.ok(rotatedKeyFromFirstAttempt && rotatedKeyFromFirstAttempt !== firstKey);

      // Xác nhận trạng thái trung gian trên GET /orders/me thật và trong PostgreSQL
      const ordersAfterFailure = await fetchMyOrdersApi(realJwt);
      const failedOrderSnapshot = findOrderForConfirmation(
        ordersAfterFailure,
        createdOrder.id
      );
      assert.ok(failedOrderSnapshot !== null);
      assert.equal(failedOrderSnapshot.status, "PAYMENT_FAILED");
      assert.ok(failedOrderSnapshot.payment !== null);
      assert.equal(failedOrderSnapshot.payment.status, "FAILED");
      assert.equal(failedOrderSnapshot.payment.failureReason, "PAYMENT_DECLINED");
      assert.equal(failedOrderSnapshot.payment.methodLast4, "0002");

      const dbOrderFailed = await prisma.order.findUniqueOrThrow({
        where: { id: createdOrder.id },
        include: { payments: true },
      });
      assert.equal(dbOrderFailed.status, "PAYMENT_FAILED");
      assert.equal((dbOrderFailed.payments as unknown[]).length, 1);

      // 4. Retry cùng Order bằng attempt / Idempotency-Key mới qua `submitRetryPaymentApi` (Confirmation Retry flow)
      const secondKey = generateIdempotencyKey();
      assert.notEqual(secondKey, firstKey, "Retry attempt phải dùng Idempotency-Key mới");

      const retryResponse = await submitRetryPaymentApi({
        orderId: createdOrder.id,
        method: "CARD",
        identifier: "1234567890121234",
        token: realJwt,
        idempotencyKey: secondKey,
        expectedAmountVnd: createdOrder.totalVnd,
      });

      assert.equal(retryResponse.orderId, createdOrder.id);
      assert.equal(retryResponse.paymentStatus, "SUCCESS");
      assert.equal(retryResponse.orderStatus, "PAID");
      assert.equal(retryResponse.amountVnd, 70000);
      assert.equal(retryResponse.methodLast4, "1234");
      assert.equal(retryResponse.pointsEarned, 7);
      assert.equal(retryResponse.failureReason, null);

      // 5. Gọi GET /orders/me thật xác nhận trạng thái cuối cùng là PAID và PaymentSummary là SUCCESS
      const ordersAfterRetry = await fetchMyOrdersApi(realJwt);
      const finalOrderSnapshot = findOrderForConfirmation(
        ordersAfterRetry,
        createdOrder.id
      );
      assert.ok(finalOrderSnapshot !== null);
      assert.equal(finalOrderSnapshot.id, createdOrder.id);
      assert.equal(finalOrderSnapshot.status, "PAID");
      assert.equal(finalOrderSnapshot.pointsEarned, 7);
      assert.ok(finalOrderSnapshot.payment !== null);
      assert.equal(finalOrderSnapshot.payment.id, retryResponse.paymentId);
      assert.equal(finalOrderSnapshot.payment.status, "SUCCESS");
      assert.equal(finalOrderSnapshot.payment.methodLast4, "1234");
      assert.equal(finalOrderSnapshot.payment.failureReason, null);

      // 6. Xác nhận trực tiếp trong PostgreSQL test DB rằng cả 2 attempt (1 FAILED, 1 SUCCESS) và Order PAID đã persist
      const dbOrderFinal = await prisma.order.findUniqueOrThrow({
        where: { id: createdOrder.id },
        include: { payments: true },
      });
      assert.equal(dbOrderFinal.status, "PAID");
      assert.equal(dbOrderFinal.pointsEarned, 7);

      const persistedPayments = dbOrderFinal.payments as Array<Record<string, unknown>>;
      assert.equal(persistedPayments.length, 2, "PostgreSQL phải lưu đủ 2 lần thử thanh toán (FAILED rồi SUCCESS)");
      const failedRecord = persistedPayments.find((p) => p.idempotencyKey === firstKey);
      const successRecord = persistedPayments.find((p) => p.idempotencyKey === secondKey);
      assert.ok(failedRecord, "Bản ghi Payment FAILED đầu tiên phải tồn tại trong DB");
      assert.equal(failedRecord.status, "FAILED");
      assert.equal(failedRecord.methodLast4, "0002");

      assert.ok(successRecord, "Bản ghi Payment SUCCESS thứ hai phải tồn tại trong DB");
      assert.equal(successRecord.status, "SUCCESS");
      assert.equal(successRecord.methodLast4, "1234");
      assert.equal(Number(successRecord.amountVnd), 70000);

      const dbUserFinal = await prisma.user.findUniqueOrThrow({
        where: { id: registeredUser.id },
      });
      assert.equal(dbUserFinal.loyaltyPoints, 7, "Điểm thưởng chỉ được cộng đúng 1 lần khi retry SUCCESS");
    });
  });

  describe("1. Complete Happy Path E2E Flow: Checkout -> Payment -> Confirmation (UI Regression)", () => {
    it("should seamlessly transition from Checkout (201 PENDING) to Payment (200 SUCCESS), clear Cart, and load Confirmation with Server Truth", async () => {
      setupDom();
      const mockToken = createValidMockJwt();
      let cartState = [createSampleCartItem()];
      dom.window.localStorage.setItem(CART_KEY, JSON.stringify(cartState));

      const pendingOrder: CreateOrderResponseDto = {
        id: "550e8400-e29b-41d4-a716-446655440010",
        status: "PENDING",
        createdAt: new Date().toISOString(),
        subtotalVnd: 70000,
        discountVnd: 0,
        totalVnd: 70000,
        couponCode: null,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà phê Sữa Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 35000,
            quantity: 2,
            unitPriceVnd: 35000,
            lineTotalVnd: 70000,
            toppings: [],
          },
        ],
      };

      const paidOrderConfirmation = createSampleOrder("PAID");

      // Mock full backend API sequence
      global.fetch = async (url, init) => {
        const u = String(url);
        // 1. POST /orders (Checkout)
        if (u.includes("/orders") && init?.method === "POST") {
          return new Response(JSON.stringify(pendingOrder), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        // 2. POST /payments (Payment)
        if (u.includes("/payments") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              paymentId: "550e8400-e29b-41d4-a716-446655440020",
              orderId: pendingOrder.id,
              paymentStatus: "SUCCESS",
              orderStatus: "PAID",
              method: "CARD",
              methodLast4: "1234",
              mockReference: "MOCK-REF-HAPPY-PATH",
              amountVnd: 70000,
              pointsEarned: 7,
              failureReason: null,
              createdAt: new Date().toISOString(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // 3. GET /orders/me (Confirmation)
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [paidOrderConfirmation],
              total: 1,
              page: 1,
              limit: 10,
              totalPages: 1,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // 4. GET /auth/me (Confirmation)
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "customer@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 7,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        // --- STEP 1: CHECKOUT ---
        const checkoutPayload: CreateOrderRequestDto = {
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440001",
              size: "M",
              quantity: 2,
              toppingIds: [],
            },
          ],
        };

        const createdOrder = await createOrderApi(checkoutPayload, mockToken);
        assert.equal(createdOrder.status, "PENDING");
        assert.equal(createdOrder.id, pendingOrder.id);
        // Cart must be preserved during PENDING checkout
        assert.equal(cartState.length, 1);

        // --- STEP 2: PAYMENT SUBMISSION ---
        let paymentOutcome: PaymentResponseDto | null = null;
        let cartCleared = false;
        let pointsAccrued = 0;

        const paymentDeps: ExecutePaymentSubmissionDeps = {
          activeOrder: createdOrder,
          orderStatus: "PENDING",
          payload: {
            orderId: createdOrder.id,
            method: "CARD",
            paymentDetails: { cardNumber: "1234567890121234" },
          },
          idempotencyKey: generateIdempotencyKey(),
          accessToken: mockToken,
          isAuthenticated: true,
          verifySession: () => true,
          openAuthModal: () => {},
          submittingRef: { current: false },
          isSubmitting: false,
          setIsSubmitting: () => {},
          setIdempotencyKey: () => {},
          setPaymentResult: (res) => {
            paymentOutcome = res;
          },
          setOrderStatus: () => {},
          setPaymentError: () => {},
          clearCart: () => {
            cartCleared = true;
            cartState = [];
            dom.window.localStorage.removeItem(CART_KEY);
          },
          onPointsEarned: (pts) => {
            pointsAccrued += pts;
          },
        };

        await executePaymentSubmission(paymentDeps);

        // Verification after payment
        assert.ok(paymentOutcome !== null);
        const settledOutcome = paymentOutcome as unknown as PaymentResponseDto;
        assert.equal(settledOutcome.paymentStatus, "SUCCESS");
        assert.equal(settledOutcome.orderStatus, "PAID");
        assert.equal(cartCleared, true, "Cart must be cleared on confirmed payment SUCCESS");
        assert.equal(pointsAccrued, 7);

        // --- STEP 3: CONFIRMATION VIA SERVER TRUTH ---
        const myOrders = await fetchMyOrdersApi(mockToken);
        const confirmationOrder = findOrderForConfirmation(myOrders, createdOrder.id);
        assert.ok(confirmationOrder !== null);
        assert.equal(confirmationOrder.status, "PAID");
        assert.equal(confirmationOrder.totalVnd, 70000);

        const profile = await fetchAuthMeProfile(mockToken);
        assert.ok(profile);
        assert.equal(profile.loyaltyPoints, 7);
      } finally {
        global.fetch = NATIVE_FETCH;
        cleanupDom();
      }
    });
  });

  describe("2. FAILED Payment -> Confirmation Retry SUCCESS Flow (UI Regression)", () => {
    it("should preserve Cart on FAILED payment, allow retry from Confirmation, rotate key, and clear Cart only once after SUCCESS", async () => {
      setupDom();
      const mockToken = createValidMockJwt();
      let cartItems = [createSampleCartItem()];
      dom.window.localStorage.setItem(CART_KEY, JSON.stringify(cartItems));

      const testOrder = createSampleOrder("PAYMENT_FAILED");
      const capturedKeys: string[] = [];

      global.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/payments")) {
          const headers = (init?.headers || {}) as Record<string, string>;
          capturedKeys.push(headers["Idempotency-Key"] || headers["idempotency-key"]);

          if (capturedKeys.length === 1) {
            // First payment: Declined
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440051",
                orderId: testOrder.id,
                paymentStatus: "FAILED",
                orderStatus: "PAYMENT_FAILED",
                method: "CARD",
                methodLast4: "0002",
                mockReference: "MOCK-DECLINED-0002",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 0,
                failureReason: "PAYMENT_DECLINED",
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          } else {
            // Second payment (Retry): Success
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440052",
                orderId: testOrder.id,
                paymentStatus: "SUCCESS",
                orderStatus: "PAID",
                method: "CARD",
                methodLast4: "1234",
                mockReference: "MOCK-RETRY-SUCCESS",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 7,
                failureReason: null,
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        // --- STEP 1: First payment fails ---
        let firstSubmitCartCleared = false;
        const firstDeps: ExecutePaymentSubmissionDeps = {
          activeOrder: testOrder as unknown as CreateOrderResponseDto,
          orderStatus: "PENDING",
          payload: {
            orderId: testOrder.id,
            method: "CARD",
            paymentDetails: { cardNumber: "1234567890120002" },
          },
          idempotencyKey: generateIdempotencyKey(),
          accessToken: mockToken,
          isAuthenticated: true,
          verifySession: () => true,
          openAuthModal: () => {},
          submittingRef: { current: false },
          isSubmitting: false,
          setIsSubmitting: () => {},
          setIdempotencyKey: () => {},
          setPaymentResult: () => {},
          setOrderStatus: () => {},
          setPaymentError: () => {},
          clearCart: () => {
            firstSubmitCartCleared = true;
          },
        };

        const firstResult = await executePaymentSubmission(firstDeps);
        assert.ok(firstResult.outcome);
        assert.equal(firstResult.outcome.type, "failed");
        assert.equal(firstSubmitCartCleared, false, "Cart MUST NOT be cleared when payment FAILED");
        assert.equal(cartItems.length, 1, "Cart items must be preserved");

        // --- STEP 2: Mount Confirmation Retry View with CartProvider ---
        const container = dom.window.document.getElementById("root")!;
        const root = createRoot(container);

        function MountedConfirmationFlowHarness({ order }: { order: OrderConfirmationData }) {
          const { items, clearCart } = useCart();
          const handleRetrySuccess = async () => {
            clearCart();
            clearStoredActiveOrder();
            cartItems = [];
          };

          return React.createElement(
            "div",
            null,
            React.createElement("span", { id: "flowCartCount" }, String(items.length)),
            React.createElement(PaymentFailedRetryView, {
              order,
              token: mockToken,
              onRetrySuccess: handleRetrySuccess,
              onRetryFailure: async () => null,
            })
          );
        }

        await act(async () => {
          root.render(
            React.createElement(
              CartProvider as React.ComponentType<{ key?: string }>,
              { key: "flow-retry" },
              React.createElement(MountedConfirmationFlowHarness, { order: testOrder })
            )
          );
        });

        assert.equal(container.querySelector("#flowCartCount")?.textContent, "1");

        // User submits retry payment with valid card
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(capturedKeys.length, 2);
        assert.notEqual(capturedKeys[0], capturedKeys[1], "Key must be rotated on retry");
        // Verify cart is cleared exactly once after retry SUCCESS
        assert.equal(container.querySelector("#flowCartCount")?.textContent, "0");
        assert.equal(cartItems.length, 0);

        await act(async () => {
          root.unmount();
        });
      } finally {
        global.fetch = NATIVE_FETCH;
        cleanupDom();
      }
    });
  });

  describe("3. Network Error & Idempotency Key Preservation Integration", () => {
    it("should preserve the EXACT same Idempotency-Key on network timeout and succeed on second attempt without duplicate effects", async () => {
      setupDom();
      const mockToken = createValidMockJwt();
      const testOrder = createSampleOrder("PAYMENT_FAILED");

      const capturedKeys: string[] = [];
      let fetchAttempts = 0;

      global.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/payments")) {
          fetchAttempts += 1;
          const headers = (init?.headers || {}) as Record<string, string>;
          capturedKeys.push(headers["Idempotency-Key"] || headers["idempotency-key"]);

          if (fetchAttempts === 1) {
            throw new TypeError("Failed to fetch (DNS timeout)");
          } else {
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440088",
                orderId: testOrder.id,
                paymentStatus: "SUCCESS",
                orderStatus: "PAID",
                method: "CARD",
                methodLast4: "1234",
                mockReference: "MOCK-REPLAYED-SAME-KEY",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 7,
                failureReason: null,
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        const container = dom.window.document.getElementById("root")!;
        const root = createRoot(container);
        let retrySuccessCalled = false;

        await act(async () => {
          root.render(
            React.createElement(PaymentFailedRetryView, {
              order: testOrder,
              token: mockToken,
              onRetrySuccess: () => {
                retrySuccessCalled = true;
              },
            })
          );
        });

        // First attempt -> Network error
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(capturedKeys.length, 1);
        assert.equal(retrySuccessCalled, false);
        assert.match(container.innerHTML, /Không thể kết nối đến máy chủ|Idempotency-Key đã được giữ nguyên/i);

        // Second attempt -> Retry with same key
        await act(async () => {
          const btnSameKey = container.querySelector("#btnRetrySameKey") as HTMLButtonElement;
          if (btnSameKey) {
            btnSameKey.click();
          } else {
            const form = container.querySelector("form") as HTMLFormElement;
            form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
          }
        });

        assert.equal(capturedKeys.length, 2);
        assert.equal(
          capturedKeys[0],
          capturedKeys[1],
          "Idempotency-Key BẮT BUỘC phải giữ nguyên khi thử lại sau lỗi mạng"
        );
        assert.equal(retrySuccessCalled, true);

        await act(async () => {
          root.unmount();
        });
      } finally {
        global.fetch = NATIVE_FETCH;
        cleanupDom();
      }
    });
  });

  describe("4. 409 INVALID_TRANSITION -> Server Truth CANCELLED Terminal State Integration", () => {
    it("should fetch latest server truth on 409 INVALID_TRANSITION and immediately hide retry form when order is CANCELLED", async () => {
      setupDom();
      const mockToken = createValidMockJwt();
      let liveServerOrder = createSampleOrder("PAYMENT_FAILED");

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          return new Response(
            JSON.stringify({
              statusCode: 409,
              message: "INVALID_TRANSITION: Cannot transition order from CANCELLED to PAID",
              error: "Conflict",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        const container = dom.window.document.getElementById("root")!;
        const root = createRoot(container);
        let refetchCalled = false;

        const mockReload = async (): Promise<OrderConfirmationData | null> => {
          refetchCalled = true;
          liveServerOrder = {
            ...liveServerOrder,
            status: "CANCELLED",
          };
          return liveServerOrder;
        };

        const renderView = () =>
          React.createElement(PaymentFailedRetryView, {
            order: liveServerOrder,
            token: mockToken,
            onRetrySuccess: () => {},
            onRetryFailure: mockReload,
          });

        await act(async () => {
          root.render(renderView());
        });

        assert.ok(container.querySelector("#btnSubmitRetryPayment"));

        // Click submit -> Triggers 409 INVALID_TRANSITION
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(refetchCalled, true, "onRetryFailure phải được gọi để reload server truth");

        // Re-render with server truth CANCELLED
        await act(async () => {
          root.render(renderView());
        });

        // Form and submit button must be completely gone
        assert.equal(container.querySelector("#btnSubmitRetryPayment"), null);
        assert.equal(container.querySelector("form"), null);
        assert.ok(container.querySelector("#orderTerminalStateNotice"));
        assert.match(container.innerHTML, /đã bị hủy/i);

        await act(async () => {
          root.unmount();
        });
      } finally {
        global.fetch = NATIVE_FETCH;
        cleanupDom();
      }
    });
  });

  describe("5. User Isolation & Multi-Account Protection Integration", () => {
    it("should prevent User B from viewing User A's order confirmation snapshot (isolation invariant)", async () => {
      const userAToken = createValidMockJwt("user-a-uuid-0001");
      const userBToken = createValidMockJwt("user-b-uuid-0002");

      const userAOrder = createSampleOrder("PAID", {
        id: "550e8400-e29b-41d4-a716-446655440010",
      });
      const userBOrder = createSampleOrder("PAID", {
        id: "550e8400-e29b-41d4-a716-446655440099",
      });

      global.fetch = async (url, init) => {
        const u = String(url);
        const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] || "";

        if (u.includes("/orders/me")) {
          if (authHeader.includes(userAToken)) {
            return new Response(
              JSON.stringify({
                items: [userAOrder],
                total: 1,
                page: 1,
                limit: 10,
                totalPages: 1,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          if (authHeader.includes(userBToken)) {
            return new Response(
              JSON.stringify({
                items: [userBOrder],
                total: 1,
                page: 1,
                limit: 10,
                totalPages: 1,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        // 1. User A can find their own order
        const ordersA = await fetchMyOrdersApi(userAToken);
        const matchA = findOrderForConfirmation(ordersA, userAOrder.id);
        assert.ok(matchA !== null);
        assert.equal(matchA.id, userAOrder.id);

        // 2. User B tries to look up User A's orderId -> must return null
        const ordersB = await fetchMyOrdersApi(userBToken);
        const matchB = findOrderForConfirmation(ordersB, userAOrder.id);
        assert.equal(matchB, null, "User B TUYỆT ĐỐI không thể tra cứu đơn của User A");
      } finally {
        global.fetch = NATIVE_FETCH;
      }
    });
  });

  describe("6. Zero VND Free Order End-to-End Integration (API Contract v3.0 §3.2)", () => {
    it("should successfully process 0 VND order (100% coupon discount) through payment and confirmation", async () => {
      const mockToken = createValidMockJwt();
      const freeOrder = createSampleOrder("PENDING", {
        id: "550e8400-e29b-41d4-a716-446655440000",
        subtotalVnd: 50000,
        discountVnd: 50000,
        totalVnd: 0,
        couponCode: "FREE100",
        pointsEarned: 0,
      });

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          return new Response(
            JSON.stringify({
              paymentId: "550e8400-e29b-41d4-a716-446655440005",
              orderId: freeOrder.id,
              paymentStatus: "SUCCESS",
              orderStatus: "PAID",
              method: "CARD",
              methodLast4: "1234",
              mockReference: "MOCK-ZERO-VND",
              amountVnd: 0,
              pointsEarned: 0,
              failureReason: null,
              createdAt: new Date().toISOString(),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        const result = await submitRetryPaymentApi({
          orderId: freeOrder.id,
          method: "CARD",
          identifier: "1234567890121234",
          token: mockToken,
          expectedAmountVnd: 0,
        });

        assert.equal(result.paymentStatus, "SUCCESS");
        assert.equal(result.orderStatus, "PAID");
        assert.equal(result.amountVnd, 0);
        assert.equal(result.pointsEarned, 0);
      } finally {
        global.fetch = NATIVE_FETCH;
      }
    });
  });
});
