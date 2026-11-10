// The lyrics service under constant garbage collection, for tests:
// `gjs -m tests/service-under-gc.js --settings <path>`.
// Static imports run in order before this body, so the collector starts
// first. A dynamic import() would run the service inside a promise job,
// where its main loop blocks every later promise continuation.
import './collect-garbage.js';
import '../service/main.js';
