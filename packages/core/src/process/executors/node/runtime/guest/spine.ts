/**
 * Guest-side runtime spine: synchronous host capability calls, asynchronous host operations
 * settled by the host, event targets that the host delivers to, and keep-alive holds.
 * Module snippets build on these helpers. Plain JavaScript, no template interpolation.
 */
export const SPINE_SRC = String.raw`
var PENDING_OPS = Object.create(null);
var nextOpId = 1;
var TARGETS = Object.create(null);
var nextTargetId = 1;

function operationError(envelope) {
  var err = new Error(envelope.message || envelope.code || 'operation failed');
  if (envelope.code) err.code = envelope.code;
  if (envelope.errno !== undefined) err.errno = envelope.errno;
  if (envelope.syscall) err.syscall = envelope.syscall;
  if (envelope.props) {
    var keys = Object.keys(envelope.props);
    for (var i = 0; i < keys.length; i++) err[keys[i]] = envelope.props[keys[i]];
  }
  return err;
}

function callCap(op, args) {
  var envelope = JSON.parse(host.cap(op, JSON.stringify(args === undefined ? {} : args)));
  if (!envelope.ok) throw operationError(envelope);
  return envelope.value;
}

function callOp(op, args) {
  var opId = nextOpId++;
  return new Promise(function (resolve, reject) {
    PENDING_OPS[opId] = { resolve: resolve, reject: reject };
    host.start(op, JSON.stringify(args === undefined ? {} : args), opId);
  });
}

function createTarget(handler) {
  var id = nextTargetId++;
  TARGETS[id] = handler;
  return id;
}

function deleteTarget(id) {
  delete TARGETS[id];
}

function holdRef(delta) {
  host.ref(delta);
}

api.settle = function (opId, envelopeJson) {
  var waiter = PENDING_OPS[opId];
  if (!waiter) return;
  delete PENDING_OPS[opId];
  var envelope = JSON.parse(envelopeJson);
  if (envelope.ok) waiter.resolve(envelope.value);
  else waiter.reject(operationError(envelope));
};

api.deliver = function (targetId, name, payloadJson) {
  var handler = TARGETS[targetId];
  if (!handler) return;
  handler(name, JSON.parse(payloadJson));
};
`;
