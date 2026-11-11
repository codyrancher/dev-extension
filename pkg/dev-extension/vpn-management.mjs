/**
 * Talking to OpenVPN's management interface: the part of the shared VPN that answers its questions.
 *
 * The ECM lab's VPN asks for a password and then, separately, for a one-time code: OpenVPN's
 * dynamic challenge/response. The server refuses the first login with
 * `CRV1:R,E:<state id>:<base64 username>:<prompt>`, and the client logs in again with the username
 * from the challenge and the password `CRV1::<state id>::<code>`. A server can instead announce a
 * static challenge up front (`SC:<echo>,<prompt>` on the password query), answered with
 * `SCRV1:<base64 password>:<base64 code>`; both are handled, since which one a server uses is its
 * own choice and the profile does not say.
 *
 * A code is good once. So a password query that arrives with no unused code - the server ending the
 * session, the daily kick - is not answered: the session is over until the person logs in again,
 * and that is what `need-login` says.
 *
 * Pure, and with no imports, because the controller in the VPN pod is this file's text: dev-api
 * ships it into the pod (vpn-pod.mjs), and node --test loads it directly.
 */

/** A value quoted the way the management interface reads one: double quotes, `\` and `"` escaped. */
export function mgmtQuote(value) {
  return `"${ String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') }"`;
}

/** Named for this file: dev-api inlines it beside its own top-level names. */
export const vpnB64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
export const vpnUnb64 = (s) => {
  try {
    return Buffer.from(String(s ?? ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
};

/** A dynamic challenge out of a refusal, or null: `CRV1:<flags>:<state id>:<base64 username>:<prompt>`. */
export function readCrv1(text) {
  const m = /CRV1:([^:]*):([^:]*):([^:]*):(.*)$/.exec(String(text || '').replace(/['\]]+$/, ''));

  return m ? {
    flags: m[1], state: m[2], user: vpnUnb64(m[3]), prompt: m[4].trim(), echo: m[1].split(',').includes('E'),
  } : null;
}

/** A fresh session for one login: what the person gave, and what has been used of it. */
export function newSession({ username = '', password = '', otp = '' } = {}) {
  return {
    username, password, otp, otpUsed: false, passwordSent: false, crv1: null,
  };
}

/**
 * One line from the management interface, and what to do about it.
 *
 * Returns `{ send, state, end }`: lines to write back, a change of state to report (`phase` is one
 * of connecting, challenge, connected, reconnecting, need-login, failed, down), and whether this
 * openvpn should be stopped. Mutates `session` for what it has used.
 */
export function managementStep(line, session, now = new Date().toISOString()) {
  const out = { send: [], state: null, end: false };
  const text = String(line || '').replace(/\r$/, '');

  if (text.startsWith('>HOLD:')) {
    out.send.push('hold release');

    return out;
  }

  if (text.startsWith('>PASSWORD:Need \'Auth\'')) {
    const sc = /SC:(\d),(.*)$/.exec(text);

    if (sc) {
      if (session.otp && !session.otpUsed) {
        session.otpUsed = true;
        session.passwordSent = true;
        out.send.push(`username "Auth" ${ mgmtQuote(session.username) }`, `password "Auth" ${ mgmtQuote(`SCRV1:${ vpnB64(session.password) }:${ vpnB64(session.otp) }`) }`);
        out.state = { phase: 'connecting', note: 'sent the password and code' };
      } else {
        out.state = { phase: 'need-login', note: 'The VPN wants a new code.', at: now };
        out.end = true;
      }

      return out;
    }
    if (session.crv1) {
      if (session.otp && !session.otpUsed) {
        const { state, user } = session.crv1;

        session.otpUsed = true;
        session.crv1 = null;
        out.send.push(`username "Auth" ${ mgmtQuote(user || session.username) }`, `password "Auth" ${ mgmtQuote(`CRV1::${ state }::${ session.otp }`) }`);
        out.state = { phase: 'connecting', note: 'sent the code' };
      } else {
        out.state = { phase: 'need-login', note: 'The VPN asked for a code.', at: now };
        out.end = true;
      }

      return out;
    }
    if (!session.passwordSent && session.password) {
      session.passwordSent = true;
      out.send.push(`username "Auth" ${ mgmtQuote(session.username) }`, `password "Auth" ${ mgmtQuote(session.password) }`);
      out.state = { phase: 'connecting', note: 'sent the username and password' };

      return out;
    }
    // Asked again with nothing new to give: the session the code opened is over.
    out.state = { phase: 'need-login', note: 'The VPN ended the session; it needs a new code.', at: now };
    out.end = true;

    return out;
  }

  if (text.startsWith('>PASSWORD:Verification Failed:')) {
    const challenge = readCrv1(text);

    if (challenge) {
      session.crv1 = challenge;
      out.state = session.otp && !session.otpUsed
        ? { phase: 'challenge', note: challenge.prompt || 'The VPN asked for the code.' }
        : { phase: 'need-login', note: challenge.prompt || 'The VPN asked for a code.', at: now };
      out.end = !(session.otp && !session.otpUsed);

      return out;
    }
    out.state = { phase: 'failed', note: 'The VPN refused the login: check the password, and use a fresh code.', at: now };
    out.end = true;

    return out;
  }

  if (text.startsWith('>STATE:')) {
    // >STATE:<unix time>,<state>,<detail>,<local ip>,<remote ip>,...
    const [, name, detail = '', local = '', remote = ''] = text.slice(7).split(',');
    const map = {
      CONNECTED: 'connected', RECONNECTING: 'reconnecting', EXITING: 'down', CONNECTING: 'connecting', WAIT: 'connecting', AUTH: 'connecting', GET_CONFIG: 'connecting', ASSIGN_IP: 'connecting', ADD_ROUTES: 'connecting', RESOLVE: 'connecting', TCP_CONNECT: 'connecting',
    };
    const phase = map[name];

    if (phase === 'connected') {
      out.state = name === 'CONNECTED' && detail === 'SUCCESS'
        ? {
          phase: 'connected', since: now, address: local, server: remote, note: '',
        }
        : { phase: 'failed', note: `Connected with errors (${ detail }).`, at: now };
    } else if (phase) {
      out.state = { phase, note: detail ? detail.toLowerCase().replace(/[-_]/g, ' ') : '' };
    }

    return out;
  }

  if (text.startsWith('>FATAL:')) {
    out.state = { phase: 'failed', note: text.slice(7).trim(), at: now };
    out.end = true;
  }

  return out;
}
