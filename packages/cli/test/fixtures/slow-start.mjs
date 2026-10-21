/**
 * Test preload (`node --import <this> cli.js ...`): a slow process start. It
 * blocks for PLUR_TEST_SLOW_START_MS before the CLI's own modules load, as a
 * busy machine or a cold disk does. Nothing in production reads this variable.
 */
const ms = Number(process.env.PLUR_TEST_SLOW_START_MS ?? 0)
if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
