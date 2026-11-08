import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JwtService } from '@nestjs/jwt';

describe('SCRUM-71 - AuthService.getMe', () => {
  const userId = '550e8400-e29b-41d4-a716-446655440000';

  const customer = {
    id: userId,
    email: 'customer@example.com',
    fullName: 'Nguyen Van A',
    loyaltyPoints: 125,
  };

  let service: AuthService;
  let findUnique: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findUnique = vi.fn();

    const prisma = {
      user: { findUnique },
    } as unknown as PrismaService;

    const jwt = {} as JwtService;

    service = new AuthService(prisma, jwt);
  });

  it('AUTH-ME-01: returns the four approved fields', async () => {
    findUnique.mockResolvedValue(customer);

    const result = await service.getMe(userId);

    expect(result).toEqual(customer);
    expect(Object.keys(result).sort()).toEqual(
      ['id', 'email', 'fullName', 'loyaltyPoints'].sort(),
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        loyaltyPoints: true,
      },
    });
  });

  it('AUTH-ME-02: returns 401 when user no longer exists', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.getMe(userId)).rejects.toMatchObject({
      status: 401,
      response: {
        code: 'UNAUTHORIZED',
      },
    });
  });

  it('AUTH-ME-03: supports nullable fullName', async () => {
    findUnique.mockResolvedValue({
      ...customer,
      fullName: null,
    });

    const result = await service.getMe(userId);

    expect(result.fullName).toBeNull();
  });

  it('AUTH-ME-04: reads the latest persisted loyalty points', async () => {
    findUnique
      .mockResolvedValueOnce({ ...customer, loyaltyPoints: 0 })
      .mockResolvedValueOnce({ ...customer, loyaltyPoints: 25 });

    const first = await service.getMe(userId);
    const second = await service.getMe(userId);

    expect(first.loyaltyPoints).toBe(0);
    expect(second.loyaltyPoints).toBe(25);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('AUTH-ME-05: hides database errors behind 500', async () => {
    findUnique.mockRejectedValue(new Error('Sensitive database error'));

    await expect(service.getMe(userId)).rejects.toMatchObject({
      status: 500,
      response: {
        code: 'INTERNAL_ERROR',
      },
    });
  });

  it('AUTH-ME-06: returns unauthorized rather than not found', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.getMe(userId)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
