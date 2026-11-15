// Test only: loaded into one hub with `node --import` so its sockets can be made to fail on send,
// which a healthy socket never does. An eval whose code contains FAULT_SEND fails to send; after
// an eval containing FAULT_CANCEL, the next cancel fails to send.
import { WebSocket } from 'ws';

const send = WebSocket.prototype.send;
let failNextCancel = false;
WebSocket.prototype.send = function (data, ...rest) {
  if (typeof data === 'string') {
    if (data.includes('FAULT_SEND')) throw new Error('simulated send failure');
    if (data.includes('FAULT_CANCEL')) failNextCancel = true;
    else if (failNextCancel && data.includes('"method":"cancel"')) {
      failNextCancel = false;
      throw new Error('simulated send failure');
    }
  }
  return send.call(this, data, ...rest);
};
