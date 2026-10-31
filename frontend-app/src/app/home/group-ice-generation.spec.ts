import {iceCandidateIdentity, iceGenerations, matchesIceGeneration, outgoingIceCandidate} from './group-ice-generation';

describe('group ICE generation identity', () => {
    it('uses session and media ufrags and requires both media selectors when supplied', () => {
        const sdp = 'v=0\r\na=ice-ufrag:session\r\na=ice-pwd:password\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=ice-ufrag:videoice\r\n';
        const generations = iceGenerations(sdp);
        expect(generations).toEqual([{mid: 'audio', index: 0, ufrag: 'session', password: 'password'}, {mid: 'video', index: 1, ufrag: 'videoice', password: 'password'}]);
        expect(matchesIceGeneration({ufrag: 'session', mid: 'audio', index: 0}, generations)).toBe(true);
        expect(matchesIceGeneration({ufrag: 'session', mid: 'audio', index: 1}, generations)).toBe(false);
        expect(matchesIceGeneration({ufrag: 'videoice', index: 1}, generations)).toBe(true);
    });

    it('rejects missing and contradictory candidate identifiers', () => {
        const line = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host';
        expect(iceCandidateIdentity({candidate: line, sdpMid: 'audio'})).toBeUndefined();
        expect(iceCandidateIdentity({candidate: `${line} ufrag old`, usernameFragment: 'new', sdpMid: 'audio'})).toBeUndefined();
        expect(iceCandidateIdentity({candidate: `${line} ufrag old ufrag new`, sdpMid: 'audio'})).toBeUndefined();
        expect(iceCandidateIdentity({candidate: line, usernameFragment: 'new'})).toBeUndefined();
        expect(iceCandidateIdentity({candidate: `${line} ufrag old`, sdpMLineIndex: -1})).toBeUndefined();
        expect(iceCandidateIdentity({candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host ufrag old', sdpMLineIndex: 0})?.identity).toEqual({ufrag: 'old', mid: undefined, index: 0});
    });

    it('uses the BUNDLE tag transport credentials for other bundled media', () => {
        const sdp = 'v=0\r\na=group:BUNDLE audio video\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=ice-ufrag:bundle\r\na=ice-pwd:bundlepassword\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=bundle-only\r\n';
        expect(iceGenerations(sdp)).toEqual([{mid: 'audio', index: 0, ufrag: 'bundle', password: 'bundlepassword'}, {mid: 'video', index: 1, ufrag: 'bundle', password: 'bundlepassword'}]);
    });

    it('retains explicit non-tag fallback credentials in a pending BUNDLE offer', () => {
        const sdp = 'v=0\r\na=group:BUNDLE audio video\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=ice-ufrag:bundle\r\na=ice-pwd:bundlepassword\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=ice-ufrag:fallback\r\na=ice-pwd:fallbackpassword\r\n';
        expect(iceGenerations(sdp)).toEqual([{mid: 'audio', index: 0, ufrag: 'bundle', password: 'bundlepassword'}, {mid: 'video', index: 1, ufrag: 'bundle', password: 'bundlepassword'}, {mid: 'video', index: 1, ufrag: 'fallback', password: 'fallbackpassword'}]);
    });

    it('rejects arbitrary malformed candidate strings', () => {
        expect(iceCandidateIdentity({candidate: 'opaque', usernameFragment: 'current', sdpMid: 'audio'})).toBeUndefined();
    });

    it('enriches outgoing candidates only when the installed transport uniquely identifies them', () => {
        const line = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host';
        const browser = (native: string | null, json: RTCIceCandidateInit): RTCIceCandidate => ({candidate: line, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: native, toJSON: () => json} as RTCIceCandidate);
        const current = [{mid: 'audio', index: 0, ufrag: 'current', password: 'current-password'}];
        const old = [{mid: 'audio', index: 0, ufrag: 'old', password: 'old-password'}];
        expect(outgoingIceCandidate(browser(null, {candidate: line, sdpMid: 'audio', sdpMLineIndex: 0}), current, [])).toEqual({kind: 'candidate', candidate: {candidate: line, sdpMid: 'audio', sdpMLineIndex: 0, usernameFragment: 'current'}});
        expect(outgoingIceCandidate(browser('current', {candidate: line, sdpMid: 'audio'}), current, old).kind).toBe('candidate');
        expect(outgoingIceCandidate(browser('old', {candidate: line, sdpMid: 'audio'}), current, old).kind).toBe('stale');
        expect(outgoingIceCandidate(browser(null, {candidate: line, sdpMid: 'audio'}), current, old).kind).toBe('ambiguous');
        expect(outgoingIceCandidate(browser('old', {candidate: line, sdpMid: 'audio', usernameFragment: 'current'}), current, old).kind).toBe('ambiguous');
    });

    it('applies wire size and selector limits to enriched outgoing candidates', () => {
        const prefix = 'candidate:1 1 udp 1 example.invalid 9 typ host ';
        const candidate = (line: string, mid: string, index: number, ufrag: string): RTCIceCandidate => ({
            candidate: line, sdpMid: mid, sdpMLineIndex: index, usernameFragment: ufrag,
            toJSON: () => ({candidate: line, sdpMid: mid, sdpMLineIndex: index, usernameFragment: ufrag, unexpected: 'discard'}),
        } as unknown as RTCIceCandidate);
        const validLine = prefix + 'x'.repeat(4096 - prefix.length);
        const fragment = 'x'.repeat(256);
        const mid = '😀'.repeat(256);
        const generation = [{mid, index: 65535, ufrag: fragment, password: 'password'}];
        const result = outgoingIceCandidate(candidate(validLine, mid, 65535, fragment), generation, []);
        expect(result).toEqual({kind: 'candidate', candidate: {candidate: validLine, sdpMid: mid, sdpMLineIndex: 65535, usernameFragment: fragment}});
        expect(outgoingIceCandidate(candidate(validLine + 'x', mid, 65535, fragment), generation, []).kind).toBe('ambiguous');
        expect(outgoingIceCandidate(candidate(validLine, mid, 65536, fragment), [{...generation[0], index: 65536}], []).kind).toBe('ambiguous');
        expect(outgoingIceCandidate(candidate(validLine, mid + '😀', 65535, fragment), [{...generation[0], mid: mid + '😀'}], []).kind).toBe('ambiguous');
        expect(outgoingIceCandidate(candidate(validLine, mid, 65535, fragment + 'x'), [{...generation[0], ufrag: fragment + 'x'}], []).kind).toBe('ambiguous');
    });
});
