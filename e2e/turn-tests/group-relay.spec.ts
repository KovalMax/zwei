import {expect, Page, request, test} from '@playwright/test';

const password = 'Password123!';
const base = 'https://chat.localhost';
const admin = 'https://kyc.localhost';

// Test output contains only status, counters, expiry timestamps and booleans.
// Never expose credentials, SDP, candidate addresses/IDs, or WebSocket URLs.
async function installRelayObserver(page: Page, coordinateOffers: boolean): Promise<void> {
  await page.addInitScript(coordinate => {
    type SourceSnapshot = {duration: number; reports: number; sent: number; sameSender: boolean; sameTrack: boolean; sameTransceiver: boolean};
    type Peer = {connection: RTCPeerConnection; initialServers: RTCIceServer[]; initialExpiry: number; configured: boolean; restarted: boolean; beforeLocal: string; beforeRemote: string; events: string[]; sourceSteps: {step: string; snapshot: SourceSnapshot}[]; rollbackBefore?: SourceSnapshot; rollbackAfter?: SourceSnapshot; senderBefore?: RTCRtpSender; trackBefore?: MediaStreamTrack | null; transceiverBefore?: RTCRtpTransceiver};
    type Room = {conversation_id?: string; room_id?: string; generation?: number};
    type Gate = {enabled: boolean; ready: boolean; committed: boolean; released: boolean; timedOut: boolean; failed: boolean; offers: number; forceInitialRetry: boolean; droppedInitialOffer: boolean; retriedInitialOffer: boolean; frames: {socket: WebSocket; data: string}[]; bytes: number; timer?: number};
    type Observer = {peers: Peer[]; nativePeer: typeof RTCPeerConnection; pending: WeakMap<WebSocket, Map<string, Room>>; responseServers?: RTCIceServer[]; refreshedExpiry: number; refreshedAt: number; correlated: boolean; iceErrors: number[]; lastRtpIDs: string; rtpIDChanges: number; gate: Gate; drain: () => void};
    const NativePeer = window.RTCPeerConnection;
    const gate: Gate = {enabled: coordinate, ready: false, committed: false, released: false, timedOut: false, failed: false, offers: 0, forceInitialRetry: false, droppedInitialOffer: false, retriedInitialOffer: false, frames: [], bytes: 0};
    const observer: Observer = {peers: [], nativePeer: NativePeer, pending: new WeakMap(), refreshedExpiry: 0, refreshedAt: 0, correlated: false, iceErrors: [], lastRtpIDs: '', rtpIDChanges: 0, gate, drain: () => {}};
    Object.defineProperty(window, '__relayObserver', {value: observer});
    const NativeSocket = window.WebSocket;
    const send = NativeSocket.prototype.send;
    NativeSocket.prototype.send = function(data): void {
      if (typeof data === 'string') {
        let message: {type?: string; request_id?: string; payload?: Room & {signal?: {type?: string}}} | undefined;
        try { message = JSON.parse(data) as typeof message; } catch { /* Forward non-JSON frames unchanged. */ }
        if (message) {
          if (message.type === 'group.call.credentials' && message.request_id && message.payload?.room_id && message.payload.conversation_id && message.payload.generation) {
            let pending = observer.pending.get(this);
            if (!pending) { pending = new Map(); observer.pending.set(this, pending); }
            if (pending.size >= 8) pending.clear();
            pending.set(message.request_id, {room_id: message.payload.room_id, conversation_id: message.payload.conversation_id, generation: message.payload.generation});
          }
          const peer = observer.peers.length === 1 ? observer.peers[0] : undefined;
          if (gate.forceInitialRetry && peer?.configured && peer.restarted && message.type === 'group.call.signal' && message.payload?.signal?.type === 'offer') {
            if (!gate.droppedInitialOffer) { gate.droppedInitialOffer = true; return; }
            gate.retriedInitialOffer = true;
          }
          if (gate.enabled && !gate.released && message.type === 'group.call.signal' && peer?.configured && peer.restarted) {
            if (gate.timedOut || gate.failed) return;
            if (gate.frames.length >= 256 || gate.bytes + data.length > 512_000) {
              gate.failed = true;
              gate.frames.length = 0;
              return;
            }
            gate.frames.push({socket: this, data});
            gate.bytes += data.length;
            if (message.payload?.signal?.type === 'offer') {
              gate.offers++;
              if (!gate.ready) {
                gate.ready = true;
                gate.timer = window.setTimeout(() => { gate.timedOut = true; gate.frames.length = 0; }, 6_000);
              }
            }
            return;
          }
        }
      }
      send.call(this, data);
    };
    observer.drain = () => {
      if (!gate.committed || gate.timedOut || gate.failed) { gate.failed = true; gate.frames.length = 0; return; }
      window.clearTimeout(gate.timer);
      try {
        for (const frame of gate.frames) send.call(frame.socket, frame.data);
        gate.released = true;
      } catch { gate.failed = true; }
      finally { gate.frames.length = 0; gate.bytes = 0; }
    };
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        socket.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          try {
            const message = JSON.parse(event.data) as {type?: string; request_id?: string; payload?: Room & {ice_expires_at?: string; ice_servers?: RTCIceServer[]}};
            const expiry = Date.parse(message.payload?.ice_expires_at ?? '');
            const pending = observer.pending.get(socket);
            const request = message.request_id ? pending?.get(message.request_id) : undefined;
            if (message.type === 'group.call.credentials' && request && message.request_id && message.payload
              && request.room_id === message.payload.room_id && request.conversation_id === message.payload.conversation_id && request.generation === message.payload.generation
              && !observer.correlated && Number.isFinite(expiry) && message.payload.ice_servers?.length
              && Number(message.payload.ice_servers[0].username?.split(':')[0]) * 1000 === expiry) {
              pending?.delete(message.request_id);
              observer.correlated = true;
              observer.responseServers = message.payload.ice_servers;
              observer.refreshedExpiry = expiry;
              observer.refreshedAt = Date.now();
            }
          } catch { /* Never retain or report the frame. */ }
        });
        return socket;
      },
    });
    const identity = (servers: RTCIceServer[] | undefined): string => JSON.stringify((servers ?? []).map(server => ({
      urls: typeof server.urls === 'string' ? [server.urls] : server.urls,
      username: server.username, credential: server.credential,
    })));
    const selected = (connection: RTCPeerConnection): RTCIceCandidatePair | null =>
      connection.getSenders().find(sender => sender.track?.kind === 'audio')?.transport?.iceTransport.getSelectedCandidatePair() ?? null;
    window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, args, newTarget) {
        const configuration = (args[0] ?? {}) as RTCConfiguration;
        const connection = Reflect.construct(target, [{...configuration, iceTransportPolicy: 'relay'}], newTarget) as RTCPeerConnection;
        const initialServers = structuredClone(configuration.iceServers ?? []);
        const initialExpiry = Number(initialServers[0]?.username?.split(':')[0]) * 1000;
        const peer: Peer = {connection, initialServers, initialExpiry, configured: false, restarted: false, beforeLocal: '', beforeRemote: '', events: [], sourceSteps: []};
        const record = (operation: string): void => { if (observer.refreshedAt && peer.events.length < 32) peer.events.push(`${operation}/${connection.signalingState}`); };
        const sourceSnapshot = async (): Promise<SourceSnapshot> => {
          const senders = connection.getSenders();
          const sender = senders.find(item => item.track?.kind === 'audio');
          const result = {duration: 0, reports: 0, sent: 0, sameSender: !!peer.senderBefore && senders.includes(peer.senderBefore), sameTrack: !!peer.trackBefore && sender?.track === peer.trackBefore, sameTransceiver: !!peer.transceiverBefore && connection.getTransceivers().includes(peer.transceiverBefore)};
          (await connection.getStats()).forEach(report => {
            if (report.type === 'media-source' && report.kind === 'audio') { result.reports++; result.duration += report.totalSamplesDuration ?? 0; }
            if (report.type === 'outbound-rtp' && report.kind === 'audio') result.sent += report.packetsSent ?? 0;
          });
          return result;
        };
        const localDescription = connection.setLocalDescription.bind(connection);
        connection.setLocalDescription = async description => {
          record(`local-${description?.type ?? 'auto'}`);
          if ((coordinate || gate.forceInitialRetry) && description?.type === 'rollback') {
            peer.senderBefore = connection.getSenders().find(item => item.track?.kind === 'audio');
            peer.trackBefore = peer.senderBefore?.track;
            peer.transceiverBefore = connection.getTransceivers().find(item => item.sender === peer.senderBefore);
            peer.rollbackBefore = await sourceSnapshot();
          }
          await localDescription(description);
          if ((coordinate || gate.forceInitialRetry) && description?.type === 'rollback') peer.rollbackAfter = await sourceSnapshot();
          else if ((coordinate || gate.forceInitialRetry) && peer.rollbackBefore && peer.sourceSteps.length < 8) peer.sourceSteps.push({step: `local-${description?.type ?? 'auto'}`, snapshot: await sourceSnapshot()});
        };
        const remoteDescription = connection.setRemoteDescription.bind(connection);
        connection.setRemoteDescription = async description => {
          record(`remote-${description.type}`);
          await remoteDescription(description);
          if ((coordinate || gate.forceInitialRetry) && peer.rollbackBefore && peer.sourceSteps.length < 8) peer.sourceSteps.push({step: `remote-${description.type}`, snapshot: await sourceSnapshot()});
        };
        const configure = connection.setConfiguration.bind(connection);
        connection.setConfiguration = next => {
          const matched = observer.correlated && !!observer.responseServers && identity(next?.iceServers) === identity(observer.responseServers);
          // This synchronous native snapshot is taken immediately before applying
          // the matched response to this exact peer, not from a polling cache.
          const pair = matched && !peer.configured ? selected(connection) : null;
          configure({...next, iceTransportPolicy: 'relay'});
          if (pair?.local?.type === 'relay' && pair.remote?.type === 'relay' && pair.local.candidate && pair.remote.candidate) {
            record('configuration');
            peer.beforeLocal = pair.local.candidate;
            peer.beforeRemote = pair.remote.candidate;
            peer.configured = true;
          }
        };
        const restart = connection.restartIce.bind(connection);
        connection.restartIce = () => { restart(); if (peer.configured && identity(connection.getConfiguration().iceServers) === identity(observer.responseServers)) { peer.restarted = true; record('restart'); } };
        connection.addEventListener('icecandidateerror', event => { if (!observer.iceErrors.includes(event.errorCode)) observer.iceErrors.push(event.errorCode); });
        observer.peers.push(peer);
        return connection;
      },
    });
  }, coordinateOffers);
}

async function createAccount(email: string, name: string): Promise<void> {
  const api = await request.newContext({ignoreHTTPSErrors: true});
  try {
    const login = await api.post(`${admin}/api/auth/v2/login`, {headers: {Origin: admin}, data: {email: 'e2e-admin@example.test', password, device_id: `admin-${crypto.randomUUID()}`, device_name: 'TURN test'}});
    expect(login.status(), 'admin login status').toBe(200);
    const token = await login.json() as {access_token: string; token_type: string};
    const invitation = await api.post(`${admin}/api/admin/invitations`, {headers: {Authorization: `${token.token_type} ${token.access_token}`}, data: {email}});
    expect(invitation.status(), 'invitation status').toBe(201);
    const code = (await invitation.json() as {code: string}).code;
    const registered = await api.post(`${base}/api/auth/v2/register`, {headers: {Origin: base}, data: {email, password, display_name: name, device_id: `registration-${crypto.randomUUID()}`, device_name: 'TURN test', invitation_code: code}});
    expect(registered.status(), 'registration status').toBe(201);
  } finally { await api.dispose(); }
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="password"]').fill(password);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect.poll(() => page.locator('.chat-presence').textContent(), {timeout: 15_000}).toBe('Live connection');
}

type SourceSnapshot = {duration: number; reports: number; sent: number; sameSender: boolean; sameTrack: boolean; sameTransceiver: boolean};
type Sample = {relay: boolean; sent: number; received: number; sentBytes: number; receivedBytes: number; pairSentBytes: number; pairReceivedBytes: number; sourceDuration: number; sourceReports: number; lost: number; outboundReports: number; inboundReports: number; newLocal: boolean; newPair: boolean; correlated: boolean; configured: boolean; restarted: boolean; currentMatches: boolean; rtpIDChanges: number; initialExpiry: number; refreshedExpiry: number; refreshedAt: number; now: number; states: string[]; iceErrors: number[]; relayCandidates: number; tracks: string[]; transceivers: string[]; events: string[]; sourceSteps: {step: string; snapshot: SourceSnapshot}[]; rollbackBefore?: SourceSnapshot; rollbackAfter?: SourceSnapshot};
function safeDiagnostics({initialExpiry, refreshedExpiry, refreshedAt, now, ...state}: Sample) {
  return {...state, elapsedAfterExpiry: initialExpiry ? now - initialExpiry : undefined, renewalLead: refreshedAt && initialExpiry ? initialExpiry - refreshedAt : undefined, refreshedRemaining: refreshedExpiry ? refreshedExpiry - now : undefined};
}
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(async () => {
    type Snapshot = {duration: number; reports: number; sent: number; sameSender: boolean; sameTrack: boolean; sameTransceiver: boolean};
    type Peer = {connection: RTCPeerConnection; initialExpiry: number; configured: boolean; restarted: boolean; beforeLocal: string; beforeRemote: string; events: string[]; sourceSteps: {step: string; snapshot: Snapshot}[]; rollbackBefore?: Snapshot; rollbackAfter?: Snapshot};
    type Observer = {peers: Peer[]; correlated: boolean; refreshedExpiry: number; refreshedAt: number; iceErrors: number[]; lastRtpIDs: string; rtpIDChanges: number; responseServers?: RTCIceServer[]};
    const o = (window as unknown as {__relayObserver: Observer}).__relayObserver;
    const peer = o.peers.length === 1 ? o.peers[0] : undefined;
    const reportingConnection = peer?.connection;
    let relay = false, sent = 0, received = 0, sentBytes = 0, receivedBytes = 0, pairSentBytes = 0, pairReceivedBytes = 0, sourceDuration = 0, sourceReports = 0, lost = 0, relayCandidates = 0, newLocal = false, newPair = false, rtpIDsChanged = false;
    const outboundIDs: string[] = [], inboundIDs: string[] = [];
    if (reportingConnection) {
      const stats = await reportingConnection.getStats();
      let pair: RTCStats | undefined;
      stats.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId); });
      if (pair) {
        const selected = pair as RTCStats & {localCandidateId: string; remoteCandidateId: string};
        const local = stats.get(selected.localCandidateId), remote = stats.get(selected.remoteCandidateId);
        relay = local?.candidateType === 'relay' && remote?.candidateType === 'relay';
        pairSentBytes = (pair as RTCStats & {bytesSent?: number}).bytesSent ?? 0;
        pairReceivedBytes = (pair as RTCStats & {bytesReceived?: number}).bytesReceived ?? 0;
      }
      const currentPair = reportingConnection.getSenders().find(sender => sender.track?.kind === 'audio')?.transport?.iceTransport.getSelectedCandidatePair();
      newLocal = !!peer?.beforeLocal && !!currentPair?.local?.candidate && peer.beforeLocal !== currentPair.local.candidate;
      newPair = newLocal || (!!peer?.beforeRemote && !!currentPair?.remote?.candidate && peer.beforeRemote !== currentPair.remote.candidate);
      stats.forEach(report => {
        if (report.type === 'local-candidate' && report.candidateType === 'relay') relayCandidates++;
        if (report.type === 'media-source' && report.kind === 'audio') { sourceReports++; sourceDuration += report.totalSamplesDuration ?? 0; }
        if (report.type === 'outbound-rtp' && report.kind === 'audio') { outboundIDs.push(report.id); sent += report.packetsSent ?? 0; sentBytes += report.bytesSent ?? 0; }
        if (report.type === 'inbound-rtp' && report.kind === 'audio') { inboundIDs.push(report.id); received += report.packetsReceived ?? 0; receivedBytes += report.bytesReceived ?? 0; lost += report.packetsLost ?? 0; }
      });
      const currentIDs = outboundIDs.length && inboundIDs.length ? `${outboundIDs.sort().join('|')}~${inboundIDs.sort().join('|')}` : '';
      rtpIDsChanged = !!o.lastRtpIDs && !!currentIDs && o.lastRtpIDs !== currentIDs;
      if (rtpIDsChanged) o.rtpIDChanges++;
      if (currentIDs) o.lastRtpIDs = currentIDs;
    }
    const identity = (servers: RTCIceServer[] | undefined): string => JSON.stringify((servers ?? []).map(server => ({urls: typeof server.urls === 'string' ? [server.urls] : server.urls, username: server.username, credential: server.credential})));
    const currentMatches = !!o.responseServers && identity(reportingConnection?.getConfiguration().iceServers) === identity(o.responseServers);
    return {relay, sent, received, sentBytes, receivedBytes, pairSentBytes, pairReceivedBytes, sourceDuration, sourceReports, lost, outboundReports: outboundIDs.length, inboundReports: inboundIDs.length, newLocal, newPair, correlated: o.correlated, configured: !!peer?.configured, restarted: !!peer?.restarted, currentMatches, rtpIDChanges: o.rtpIDChanges, initialExpiry: peer?.initialExpiry ?? 0, refreshedExpiry: o.refreshedExpiry, refreshedAt: o.refreshedAt, now: Date.now(), states: o.peers.map(({connection: c}) => `${c.connectionState}/${c.iceConnectionState}/${c.iceGatheringState}/${c.signalingState}/local:${c.localDescription?.type ?? 'none'}/remote:${c.remoteDescription?.type ?? 'none'}/servers:${c.getConfiguration().iceServers?.length ?? 0}`), tracks: [...(reportingConnection?.getSenders().map(s => `send/${s.track?.kind ?? 'none'}/${s.track?.readyState ?? 'none'}/${s.track?.enabled ?? false}`) ?? []), ...(reportingConnection?.getReceivers().map(r => `receive/${r.track.kind}/${r.track.readyState}/${r.track.muted}`) ?? [])], transceivers: reportingConnection?.getTransceivers().map(t => `${t.direction}/${t.currentDirection ?? 'none'}/${t.sender.track?.kind ?? 'none'}/${t.sender.getParameters().encodings.map(e => e.active).join(',')}`) ?? [], events: peer?.events ?? [], sourceSteps: peer?.sourceSteps ?? [], rollbackBefore: peer?.rollbackBefore, rollbackAfter: peer?.rollbackAfter, iceErrors: o.iceErrors, relayCandidates};
  });
}

// The probe never sends SDP, candidates or credentials to Playwright. A fresh
// native connection must allocate through coturn after the actual old expiry.
async function freshAllocation(page: Page, useOriginal: boolean): Promise<boolean> {
  return page.evaluate(async original => {
    type Peer = {connection: RTCPeerConnection; initialServers: RTCIceServer[]; initialExpiry: number; configured: boolean; restarted: boolean};
    type Observer = {peers: Peer[]; nativePeer: typeof RTCPeerConnection; responseServers?: RTCIceServer[]};
    const o = (window as unknown as {__relayObserver: Observer}).__relayObserver;
    const peer = o.peers.length === 1 ? o.peers[0] : undefined;
    if (!peer || Date.now() <= peer.initialExpiry || !peer.configured || !peer.restarted) return false;
    const servers = original ? peer.initialServers : peer.connection.getConfiguration().iceServers;
    const identity = (items: RTCIceServer[] | undefined): string => JSON.stringify((items ?? []).map(server => ({urls: typeof server.urls === 'string' ? [server.urls] : server.urls, username: server.username, credential: server.credential})));
    if (!original && (!o.responseServers || identity(servers) !== identity(o.responseServers))) return false;
    const probe = new o.nativePeer({iceServers: servers, iceTransportPolicy: 'relay'});
    try {
      const allocated = new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => resolve(false), 8_000);
        probe.addEventListener('icecandidate', event => {
          if (event.candidate?.type === 'relay') { window.clearTimeout(timer); resolve(true); }
          else if (!event.candidate) { window.clearTimeout(timer); resolve(false); }
        });
      });
      probe.createDataChannel('allocation-probe');
      await probe.setLocalDescription(await probe.createOffer());
      return await allocated;
    } finally { probe.close(); }
  }, useOriginal);
}

type BarrierStatus = {ready: boolean; outstanding: boolean; committed: boolean; released: boolean; timedOut: boolean; failed: boolean; offers: number; forceInitialRetry: boolean; droppedInitialOffer: boolean; retriedInitialOffer: boolean; queued: number};
async function barrierStatus(page: Page): Promise<BarrierStatus> {
  return page.evaluate(() => {
    type Observer = {peers: {connection: RTCPeerConnection}[]; gate: {ready: boolean; committed: boolean; released: boolean; timedOut: boolean; failed: boolean; offers: number; forceInitialRetry: boolean; droppedInitialOffer: boolean; retriedInitialOffer: boolean; frames: unknown[]}};
    const o = (window as unknown as {__relayObserver: Observer}).__relayObserver;
    return {ready: o.gate.ready, outstanding: o.peers.length === 1 && o.peers[0].connection.signalingState === 'have-local-offer', committed: o.gate.committed, released: o.gate.released, timedOut: o.gate.timedOut, failed: o.gate.failed, offers: o.gate.offers, forceInitialRetry: o.gate.forceInitialRetry, droppedInitialOffer: o.gate.droppedInitialOffer, retriedInitialOffer: o.gate.retriedInitialOffer, queued: o.gate.frames.length};
  });
}

async function coordinateRestartOffers(pages: Page[]): Promise<void> {
  await expect.poll(async () => {
    const status = await Promise.all(pages.map(barrierStatus));
    if (status.some(item => item.timedOut || item.failed)) throw new Error(`restart offer barrier failed: ${JSON.stringify(status)}`);
    return status.every(item => item.ready && item.outstanding && item.offers === 1);
  }, {timeout: 60_000, intervals: [50], message: 'both real peer connections must hold their local restart offers before delivery'}).toBe(true);
  // Commit on both pages before either page transmits. No signaling value leaves
  // the page; only booleans and bounded counters cross the Playwright boundary.
  const committed = await Promise.all(pages.map(page => page.evaluate(() => {
    type Observer = {peers: {connection: RTCPeerConnection}[]; gate: {ready: boolean; committed: boolean; timedOut: boolean; failed: boolean; offers: number}};
    const o = (window as unknown as {__relayObserver: Observer}).__relayObserver;
    if (o.peers.length !== 1 || o.peers[0].connection.signalingState !== 'have-local-offer' || !o.gate.ready || o.gate.offers !== 1 || o.gate.timedOut || o.gate.failed) return false;
    o.gate.committed = true;
    return true;
  })));
  expect(committed, 'both local restart offers must still be outstanding at the barrier').toEqual([true, true]);
  await Promise.all(pages.map(page => page.evaluate(() => {
    const o = (window as unknown as {__relayObserver: {drain: () => void}}).__relayObserver;
    o.drain();
  })));
  const status = await Promise.all(pages.map(barrierStatus));
  expect(status.every(item => item.committed && item.released && !item.failed && !item.timedOut && item.queued === 0), 'both buffered streams must drain').toBe(true);
  console.log('TURN restart barrier', JSON.stringify(status));
}

for (const scenario of [
  {name: 'group audio renews actual relay credentials across their original expiry', coordinated: false, retry: false},
  {name: 'simultaneous group relay restart offers preserve audio after original expiry', coordinated: true, retry: false},
  {name: 'group relay retries a lost restart offer without losing audio', coordinated: false, retry: true},
]) test(scenario.name, async ({browser}) => {
  const ownerEmail = `turn-owner-${Date.now()}@example.test`;
  const memberEmail = `turn-member-${Date.now()}@example.test`;
  const ownerContext = await browser.newContext({baseURL: base, ignoreHTTPSErrors: true});
  const memberContext = await browser.newContext({baseURL: base, ignoreHTTPSErrors: true});
  try {
    const owner = await ownerContext.newPage(), member = await memberContext.newPage();
    await Promise.all([installRelayObserver(owner, scenario.coordinated), installRelayObserver(member, scenario.coordinated)]);
    await createAccount(ownerEmail, 'Relay Owner');
    await createAccount(memberEmail, 'Relay Member');
    await Promise.all([login(owner, ownerEmail), login(member, memberEmail)]);
    await owner.getByRole('button', {name: 'Create group'}).click();
    await owner.getByLabel('Group name').fill('Relay acceptance');
    await owner.locator('.group-create-card').getByRole('button', {name: 'Create group'}).click();
    await owner.getByLabel('Find a person').fill(memberEmail);
    await owner.getByRole('option', {name: new RegExp(memberEmail)}).click();
    await owner.getByRole('button', {name: 'Add member'}).click();
    await expect(owner.locator('.group-members li').filter({hasText: 'Relay Member'})).toBeVisible();
    await expect(member.locator('.person-option').filter({hasText: 'Relay acceptance'})).toBeVisible({timeout: 15_000});
    await member.locator('.person-option').filter({hasText: 'Relay acceptance'}).click();
    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
    await member.getByRole('button', {name: 'Join call'}).click();
    for (const page of [owner, member]) {
      await expect(page.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 15_000});
      try {
        await expect.poll(async () => (await sample(page)).relay, {timeout: 25_000, message: 'selected candidate pair must be relay on both ends'}).toBe(true);
      } catch {
        throw new Error(`selected relay pair unavailable: ${JSON.stringify((await Promise.all([sample(owner), sample(member)])).map(safeDiagnostics))}`);
      }
    }
    const before = await Promise.all([sample(owner), sample(member)]);
    for (const s of before) {
      expect(s.initialExpiry - s.now, 'initial credential still has time to exercise before expiry').toBeGreaterThan(5_000);
      expect(s.initialExpiry - s.now).toBeLessThanOrEqual(45_000);
    }
    for (const [index, page] of [owner, member].entries()) {
      await expect.poll(async () => { const s = await sample(page); return s.relay && s.sent > before[index].sent && s.received > before[index].received && s.now < before[index].initialExpiry; }, {timeout: 10_000, message: 'audio RTP must increase before original expiry'}).toBe(true);
    }
    if (scenario.retry) {
      const selected = await Promise.all([owner, member].map(page => page.evaluate(() => {
        type Observer = {peers: {connection: RTCPeerConnection}[]; gate: {forceInitialRetry: boolean}};
        const o = (window as unknown as {__relayObserver: Observer}).__relayObserver;
        if (o.peers.length !== 1 || o.peers[0].connection.currentLocalDescription?.type !== 'offer') return false;
        o.gate.forceInitialRetry = true;
        return true;
      })));
      expect(selected.filter(Boolean), 'exactly one initial offerer must exercise restart timeout').toHaveLength(1);
    }
    if (scenario.coordinated) await coordinateRestartOffers([owner, member]);
    const renewalHistory: Sample[][] = [];
    await expect.poll(async () => {
      const current = await Promise.all([sample(owner), sample(member)]);
      if (scenario.coordinated && renewalHistory.length < 128) renewalHistory.push(current);
      return current.every(s => s.now > s.initialExpiry + 2_000 && s.correlated && s.refreshedAt < s.initialExpiry && s.refreshedExpiry > s.initialExpiry && s.configured && s.restarted && s.currentMatches && s.newLocal && s.newPair && s.relay);
    }, {timeout: 70_000, intervals: [100, 250, 500], message: 'correlated renewal, same-peer configuration/restart, and a new local relay pair are required after original expiry'}).toBe(true);
    const after = await Promise.all([sample(owner), sample(member)]);
    if (scenario.coordinated) {
      expect(after.some(s => s.events.some(event => event.startsWith('local-rollback/'))), 'the coordinated offers must exercise the native collision/rollback path').toBe(true);
    }
    if (scenario.retry) {
      const retries = await Promise.all([owner, member].map(barrierStatus));
      const index = retries.findIndex(item => item.forceInitialRetry);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(retries[index].droppedInitialOffer && retries[index].retriedInitialOffer, 'the initial offerer must retry a deliberately lost restart offer').toBe(true);
      expect(after[index].events.some(event => event.startsWith('local-rollback/')), 'the retry must use native rollback').toBe(true);
    }
    // Run the allocation controls before the RTP assertion so even a one-way
    // media failure establishes whether the renewed credentials still work.
    const expiredAllocations = await Promise.all([freshAllocation(owner, true), freshAllocation(member, true)]);
    expect(expiredAllocations, 'expired original credentials must not create new relay allocations').toEqual([false, false]);
    const renewedAllocations = await Promise.all([freshAllocation(owner, false), freshAllocation(member, false)]);
    expect(renewedAllocations, 'refreshed credentials must create new relay allocations after original expiry').toEqual([true, true]);
    console.log('TURN allocation controls', JSON.stringify({expired: expiredAllocations, renewed: renewedAllocations}));
    const afterProbe = await Promise.all([sample(owner), sample(member)]);
    const history: Sample[][] = [after, afterProbe];
    for (const [index, page] of [owner, member].entries()) {
      try {
        await expect.poll(async () => {
          const current = await Promise.all([sample(owner), sample(member)]);
          history.push(current);
          const s = current[index];
          return s.relay && s.sent > after[index].sent && s.received > after[index].received;
        }, {timeout: 10_000, message: 'audio RTP must continue increasing after original expiry'}).toBe(true);
      } catch {
        const sourceStopped = renewalHistory.find(items => items.some(item => item.sourceReports > 0 && item.sourceDuration === 0));
        throw new Error(`audio RTP did not increase: ${JSON.stringify({before: before.map(safeDiagnostics), firstObservedSourceStop: sourceStopped?.map(safeDiagnostics), first: history[0].map(safeDiagnostics), last: history[history.length - 1].map(safeDiagnostics)})}`);
      }
    }
    for (let index = 0; index < afterProbe.length; index++) {
      expect(afterProbe[index].relay && afterProbe[index].sent > after[index].sent && afterProbe[index].received > after[index].received, 'relay RTP continues while fresh allocations are tested').toBe(true);
    }
    console.log('TURN RTP diagnostics', JSON.stringify(afterProbe.map((s, index) => ({
      beforeSent: before[index].sent, beforeReceived: before[index].received,
      expirySent: after[index].sent, expiryReceived: after[index].received,
      finalSent: s.sent, finalReceived: s.received, lost: s.lost,
      rtpIDChanges: s.rtpIDChanges, states: s.states, tracks: s.tracks,
      transceivers: s.transceivers, events: s.events, sourceDuration: s.sourceDuration,
    }))));
    await owner.getByRole('button', {name: 'End group call for everyone'}).click();
    await expect(member.locator('.group-call-terminal')).toContainText('Group call ended.');
  } finally {
    await Promise.all([ownerContext.close(), memberContext.close()]);
  }
});
