import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Prisma, Topping } from '../generated/prisma/client.js';

export interface CartItemInput {
  productId: string;
  size: 'S' | 'M' | 'L' | 'ONE_SIZE';
  toppingIds: string[];
  quantity: number;
}

type CartReader = Pick<Prisma.TransactionClient, 'product' | 'topping'>;

export interface PricedCartLine {
  productId: string;
  productNameSnapshot: string;
  size: CartItemInput['size'];
  sizePercentSnapshot: number;
  basePriceSnapshotVnd: bigint;
  quantity: number;
  unitPriceVnd: bigint;
  lineTotalVnd: bigint;
  selectedToppings: Topping[];
}

const SIZE_PERCENT = { S: 100, M: 120, L: 140, ONE_SIZE: 100 } as const;

const invalidCart = (productId: string, reason: string) =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'INVALID_CART',
    message: 'Invalid cart',
    details: [{ productId, reason }],
  });

export function money(value: bigint): number {
  const number = Number(value);
  if (value < 0n || !Number.isSafeInteger(number))
    throw new InternalServerErrorException('Invalid monetary amount');
  return number;
}

/**
 * Read current Product/Topping data and apply the same cart validation and
 * pricing used by Create Order. This helper is intentionally read-only.
 */
export async function priceCart(
  reader: CartReader,
  items: readonly CartItemInput[],
): Promise<{ lines: PricedCartLine[]; subtotal: bigint }> {
  const productIds = [...new Set(items.map((item) => item.productId.toLowerCase()))];
  const products = await reader.product.findMany({
    where: { id: { in: productIds } },
    include: {
      category: { select: { isActive: true } },
      productToppings: { select: { toppingId: true } },
    },
  });
  const toppingIds = [
    ...new Set(items.flatMap((item) => item.toppingIds.map((id) => id.toLowerCase()))),
  ];
  const toppings = await reader.topping.findMany({
    where: { id: { in: toppingIds } },
  });

  const lines = items.map((item) => {
    if (item.toppingIds.length > 3)
      throw invalidCart(item.productId, 'TOO_MANY_TOPPINGS');
    if (new Set(item.toppingIds.map((id) => id.toLowerCase())).size !== item.toppingIds.length)
      throw invalidCart(item.productId, 'DUPLICATE_TOPPING');
    const product = products.find(
      (candidate) => candidate.id === item.productId.toLowerCase(),
    );
    if (!product) throw invalidCart(item.productId, 'PRODUCT_NOT_FOUND');
    if (!product.category.isActive)
      throw invalidCart(product.id, 'PRODUCT_UNAVAILABLE');
    if ((product.sizePolicy === 'ONE_SIZE') !== (item.size === 'ONE_SIZE'))
      throw invalidCart(product.id, 'INVALID_SIZE');

    const selectedToppings = item.toppingIds.map((id) => {
      const normalizedId = id.toLowerCase();
      const topping = toppings.find((candidate) => candidate.id === normalizedId);
      if (!topping) throw invalidCart(product.id, 'TOPPING_NOT_FOUND');
      if (!product.productToppings.some((link) => link.toppingId === normalizedId))
        throw invalidCart(product.id, 'TOPPING_NOT_ALLOWED');
      if (!topping.isAvailable)
        throw invalidCart(product.id, 'TOPPING_UNAVAILABLE');
      return topping;
    });

    money(product.basePriceVnd);
    selectedToppings.forEach((topping) => money(topping.priceVnd));
    const sizePercentSnapshot = SIZE_PERCENT[item.size];
    // API Contract v4.0 §14.1: integer VND round-half-up, before toppings.
    const sizePriceVnd =
      (product.basePriceVnd * BigInt(sizePercentSnapshot) + 50n) / 100n;
    const unitPriceVnd =
      sizePriceVnd +
      selectedToppings.reduce((sum, topping) => sum + topping.priceVnd, 0n);
    return {
      productId: product.id,
      productNameSnapshot: product.name,
      size: item.size,
      sizePercentSnapshot,
      basePriceSnapshotVnd: product.basePriceVnd,
      quantity: item.quantity,
      unitPriceVnd,
      lineTotalVnd: unitPriceVnd * BigInt(item.quantity),
      selectedToppings,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalVnd, 0n);
  money(subtotal);
  return { lines, subtotal };
}
