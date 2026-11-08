
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('SCRUM-71 - GET /auth/me HTTP tests', () => {
  const testSecret = 'scrum71-e2e-secret-at-least-32-bytes-long';

  const userAId = '550e8400-e29b-41d4-a716-446655440001';
  const userBId = '550e8400-e29b-41d4-a716-446655440002';

  const userA = {
    id: userAId,
    email: 'customer-a@example.com',
    fullName: 'Customer A',
    loyaltyPoints: 0,
  };

  const userB = {
    id: userBId,
    email: 'customer-b@example.com',
    fullName: 'Customer B',
    loyaltyPoints: 125,
  };

  let app: INestApplication;
  let jwtService: JwtService;

  const findUnique = vi.fn();

  const users = new Map<string, typeof userA>();

  const createToken = (
    userId: string,
    expiresIn: number = 3600,
  ): string =>
    jwtService.sign(
      { sub: userId },
      { algorithm: 'HS256', expiresIn },
    );

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', testSecret);

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule.register({
          defaultStrategy: 'jwt',
        }),
        JwtModule.register({
          secret: testSecret,
          signOptions: {
            algorithm: 'HS256',
          },
        }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        JwtStrategy,
        JwtAuthGuard,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique,
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    jwtService = moduleRef.get(JwtService);
  });

  beforeEach(() => {
    users.clear();
    users.set(userAId, { ...userA });
    users.set(userBId, { ...userB });

    findUnique.mockReset();
    findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        users.get(args.where.id) ?? null,
    );
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('ME-E2E-01: accepts a valid JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${createToken(userAId)}`)
      .expect(200);

    expect(response.body).toEqual(userA);
  });

  it('ME-E2E-02: rejects a missing JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .expect(401);

    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('ME-E2E-03: rejects an invalid JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer invalid.jwt.token')
      .expect(401);

    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('ME-E2E-04: rejects an expired JWT', async () => {
    const expiredToken = createToken(userAId, -10);

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);

    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('ME-E2E-05: rejects a deleted customer', async () => {
    const token = createToken(userAId);
    users.delete(userAId);

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('ME-E2E-06: returns exactly four public fields', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${createToken(userAId)}`)
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(
      ['id', 'email', 'fullName', 'loyaltyPoints'].sort(),
    );

    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('role');
    expect(response.body).not.toHaveProperty('password');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: userAId },
      select: {
        id: true,
        email: true,
        fullName: true,
        loyaltyPoints: true,
      },
    });
  });

  it('ME-E2E-07: returns zero and non-zero loyalty points', async () => {
    const responseA = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${createToken(userAId)}`)
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${createToken(userBId)}`)
      .expect(200);

    expect(responseA.body.loyaltyPoints).toBe(0);
    expect(responseB.body.loyaltyPoints).toBe(125);
  });

  it('ME-E2E-08: isolates users by verified JWT subject', async () => {
    const response = await request(app.getHttpServer())
      .get(`/auth/me?userId=${userBId}`)
      .set('Authorization', `Bearer ${createToken(userAId)}`)
      .expect(200);

    expect(response.body.id).toBe(userAId);
    expect(response.body.email).toBe(userA.email);
    expect(response.body.id).not.toBe(userBId);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: userAId },
      }),
    );
  });
});
