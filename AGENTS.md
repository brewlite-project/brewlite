# BrewLite Agent Instructions

## 1. Language

Always respond to the user in Vietnamese.

Use clear, practical Vietnamese.

Keep standard technical terms in English when appropriate, such as:
JWT, DTO, Guard, Controller, Service, Prisma, migration, commit, push, pull, merge, build, test, API Contract.

When explaining technical issues:

- explain what is happening;
- explain why it matters;
- explain the risk;
- give the exact next action.

The user is still learning backend development, so do not assume advanced knowledge without explanation.

---

## 2. Project Context

Project name: BrewLite

Tech stack:

### Backend

- TypeScript
- NestJS
- PostgreSQL
- Prisma ORM
- REST / JSON
- Swagger / OpenAPI
- JWT / Passport authentication
- Argon2 password hashing
- Vitest / Supertest

### Frontend

- TypeScript
- Next.js
- React
- Tailwind CSS

Main branches:

- `main` = stable/release branch
- `dev` = active integration branch
- feature/review branches must branch from `dev`

Default review base branch: `dev`

---

## 3. Git Safety Rules

Never perform the following actions without explicit user approval:

- `git commit`
- `git push`
- `git merge`
- `git pull`
- `git rebase`
- `git reset`
- `git stash`
- `git cherry-pick`
- force push
- branch deletion
- history rewrite
- merging into `dev`
- merging into `main`

Do not switch branches without informing the user first.

Do not modify Git history.

Do not push changes automatically after editing code.

When reviewing a task or PR:

- review first;
- report findings;
- stop;
- wait for user approval before modifying source code.

The user remains the final decision maker.

---

## 4. Repository Workflow

Standard workflow:

1. Jira task
2. Sync `dev`
3. Create feature branch from `dev`
4. Implement
5. Build/test
6. Review diff
7. Commit
8. Push
9. Open PR to `dev`
10. Review
11. Merge
12. Integration test
13. Jira Done

The agent must not perform the Git state-changing steps above without the approvals required by the Git Safety Rules.

Prefer:

```bash
git pull --ff-only origin dev
```

Do not code directly on `main` or `dev`.

---

## 5. Source of Truth

For API implementation and review, use this priority:

1. Current approved API Contract
2. Requirements Specification
3. User Stories + Acceptance Criteria
4. Use Case Specification
5. Prisma schema / ERD
6. Existing code conventions

Do not invent request fields, response fields, business rules, status transitions, error codes, or security rules that are not supported by project sources.

If sources conflict:

- report the conflict;
- identify which files disagree;
- stop before making an architectural or business-rule assumption.

---

## 6. API Contract Rules

The API Contract is the primary implementation contract for frontend/backend integration.

Before implementing or reviewing an endpoint:

- read the relevant API Contract version;
- verify request shape;
- verify response shape;
- verify HTTP status codes;
- verify error codes;
- verify authentication/authorization rules.

Do not introduce breaking changes to previously approved endpoints unless explicitly requested.

Preserve API version history.

---

## 7. Pull Request Review Rules

When asked to review a PR or task:

1. Identify:
   - current branch;
   - base branch;
   - Jira task/scope;
   - relevant API Contract.
2. Compare the current branch against `dev`.
3. Review only changes introduced by the PR unless a pre-existing issue directly affects the PR.
4. Check:
   - correctness;
   - Jira scope compliance;
   - API Contract compliance;
   - regressions;
   - security;
   - authentication/authorization;
   - DTO and validation;
   - Prisma usage;
   - database consistency;
   - transaction correctness;
   - Swagger/OpenAPI;
   - error handling;
   - build/test status;
   - missing tests.
5. Classify findings as:
   - Blocker
   - Major
   - Minor
   - Looks good
6. Every finding should include:
   - file/path;
   - problem;
   - why it matters;
   - recommended fix.
7. Do not modify code during review unless the user explicitly asks.
8. Do not approve or merge a PR automatically.

For normal feature/task PRs, the expected base branch is `dev`.

If the current review branch is not based on `dev`, or the intended base branch is unclear:

- report the situation;
- do not rebase, switch, merge, or rewrite history;
- stop and wait for user instruction.

Only use `main` as the review base when the user explicitly identifies the PR as a release/hotfix PR or explicitly instructs otherwise.

---

## 8. Implementation Rules

When implementing a task:

1. Read project context and relevant files first.
2. Explain the current flow.
3. Identify the files that actually need modification.
4. Give a short implementation plan.
5. Do not make unrelated refactors.
6. Do not expand scope without approval.
7. Follow existing project conventions.
8. Prefer small, focused changes.
9. Run relevant build/tests after implementation.
10. Review the final diff before suggesting commit.

When the user wants to learn:

- explain before editing;
- describe Controller → Service → Prisma → Database flow;
- explain security and business-rule implications.

---

## 9. Authentication & Authorization

Security rules:

- Never store plaintext passwords.
- Never expose password hashes.
- Never log passwords or tokens.
- Never hardcode secrets.
- JWT secrets must come from environment variables.
- Never trust `userId` from the client for ownership-sensitive operations when identity is available from JWT.
- Authenticated user identity should come from verified JWT claims.
- Authentication and authorization are different concerns.
- Ownership checks must be enforced server-side.

For protected endpoints:

- verify JWT;
- derive the authenticated user;
- enforce ownership;
- never rely only on frontend restrictions.

---

## 10. Prisma & Database Rules

Database schema changes must use:

- `schema.prisma`
- Prisma migrations
- committed migration files

Do not manually change the official database schema outside migrations.

After pulling database-related changes, typical local sync flow is:

```bash
npx prisma migrate dev
npx prisma generate
```

Use:

```bash
npx prisma migrate status
```

when checking migration state.

Do not run destructive commands such as:

```bash
npx prisma migrate reset
```

without explicit user approval.

Do not create migrations during review unless explicitly requested.

In implementation mode, migration files may be created only when the task requires a schema change and the user has authorized implementation.

Creating a migration does not authorize committing it.

`git commit` still requires separate explicit user approval.

---

## 11. Testing Rules

Before declaring a task complete, check relevant commands such as:

### Backend

- build
- unit tests
- integration tests
- E2E tests

### Frontend

- build
- lint
- relevant tests

Do not claim a test passed unless it was actually run successfully.

If a test cannot be run:

- state why;
- state what remains unverified.

---

## 12. Review vs Implementation Mode

### Review mode

Default behavior:

- read;
- inspect;
- compare;
- build/test if allowed;
- report findings;
- do not modify code.

### Implementation mode

Only when explicitly requested:

- modify source code;
- explain changes;
- run checks;
- show final diff;
- stop before commit/push unless separately approved.

---

## 13. Scope Control

Do not add features just because they seem useful.

Examples of forbidden scope creep unless explicitly requested:

- new endpoints;
- new database tables;
- new auth mechanisms;
- refresh token support;
- forgot-password flow;
- admin features;
- pagination/filtering;
- CI/CD changes;
- architecture rewrites.

If a useful improvement is outside the task, mark it as:

`Deferred / Future improvement`

---

## 14. Final Decision Rule

The agent may:

- analyze;
- review;
- explain;
- propose;
- test;
- modify code only with permission.

The user decides:

- whether to change code;
- whether a finding is accepted;
- whether to commit;
- whether to push;
- whether to merge;
- whether a Jira task is Done.
