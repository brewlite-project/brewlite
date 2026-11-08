// Test-only value: production reads JWT_SECRET from the environment, with no fallback.
process.env.JWT_SECRET = 'brewlite-test-only-secret-at-least-32-bytes';
// Tests invoke the real runner explicitly; fake timers test automatic scheduling.
process.env.ORDER_EXPIRATION_ENABLED = 'false';
