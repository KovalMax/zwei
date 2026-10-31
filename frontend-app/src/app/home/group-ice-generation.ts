/** SDP and candidate identity only; never log or persist these values. */
export interface IceMediaGeneration { readonly mid: string; readonly index: number; readonly ufrag: string; readonly password: string; }
export interface IceCandidateIdentity { readonly mid?: string; readonly index?: number; readonly ufrag: string; }
export type GroupIceCandidate = RTCIceCandidateInit & {candidate: string} & ({sdpMid: string} | {sdpMLineIndex: number});

const candidateLine = /^candidate:[^ \t\n\f\r]+[ \t\n\f\r]+\d+[ \t\n\f\r]+(?:udp|tcp)[ \t\n\f\r]+\d+[ \t\n\f\r]+[^ \t\n\f\r]+[ \t\n\f\r]+\d+[ \t\n\f\r]+typ[ \t\n\f\r]+(?:host|srflx|prflx|relay)(?:[ \t\n\f\r]+[^\n]*)?(?![\s\S])/iu;
const iceUfrag = /(?:^|[ \t\n\f\r])ufrag[ \t\n\f\r]+([^ \t\n\f\r]+)/g;
const unicodeSpace = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

function embeddedUfrags(line: string): string[] {
    const matches: string[] = [];
    iceUfrag.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = iceUfrag.exec(line)) !== null) matches.push(match[1]);
    return matches;
}

export function iceGenerations(sdp: string): IceMediaGeneration[] {
    let sessionUfrag: string | undefined;
    let sessionPassword: string | undefined;
    const media: {mid?: string; ufrag?: string; password?: string; index: number}[] = [];
    const bundles: string[][] = [];
    for (const line of sdp.split(/\r?\n/)) {
        if (line.startsWith('m=')) media.push({index: media.length});
        else if (!media.length && line.startsWith('a=group:BUNDLE ')) bundles.push(line.slice(15).trim().split(/\s+/));
        else if (line.startsWith('a=ice-ufrag:')) {
            const value = line.slice(12).trim();
            if (media.length) media[media.length - 1].ufrag = value;
            else sessionUfrag = value;
        } else if (line.startsWith('a=ice-pwd:')) {
            const value = line.slice(10).trim();
            if (media.length) media[media.length - 1].password = value;
            else sessionPassword = value;
        } else if (line.startsWith('a=mid:') && media.length) media[media.length - 1].mid = line.slice(6).trim();
    }
    const generations: IceMediaGeneration[] = [];
    for (const section of media) {
        const bundle = bundles.find(group => section.mid && group.includes(section.mid));
        const transport = bundle ? media.find(item => item.mid === bundle[0]) : section;
        const ufrag = transport?.ufrag || (transport ? sessionUfrag : undefined);
        const password = transport?.password || (transport ? sessionPassword : undefined);
        if (section.mid && ufrag && password) generations.push({mid: section.mid, index: section.index, ufrag, password});
        // A pending BUNDLE offer can also describe an independent fallback
        // transport until the answer selects the bundle. Do not lose that
        // explicitly signaled media identity while trickle ICE is in flight.
        const ownUfrag = section.ufrag || sessionUfrag;
        const ownPassword = section.password || sessionPassword;
        if (bundle && section.mid && ownUfrag && ownPassword && (ownUfrag !== ufrag || ownPassword !== password)) {
            generations.push({mid: section.mid, index: section.index, ufrag: ownUfrag, password: ownPassword});
        }
    }
    return generations;
}

export function iceCandidateIdentity(value: unknown): {candidate: GroupIceCandidate; identity: IceCandidateIdentity} | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).some(key => !['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'].includes(key))) return undefined;
    const line = candidate.candidate;
    if (typeof line !== 'string' || Array.from(line).length > 4096 || (line !== '' && !candidateLine.test(line))) return undefined;
    const matches = embeddedUfrags(line);
    if (matches.length > 1) return undefined;
    const embedded = matches[0];
    if (embedded && Array.from(embedded).length > 256) return undefined;
    const username = candidate.usernameFragment;
    if (username != null && (typeof username !== 'string' || !username || Array.from(username).length > 256 || unicodeSpace.test(username))) return undefined;
    if (embedded && username && embedded !== username) return undefined;
    const ufrag = username || embedded;
    const mid = candidate.sdpMid;
    const index = candidate.sdpMLineIndex;
    if (!ufrag || (mid == null && index == null) || (mid != null && (typeof mid !== 'string' || !mid || Array.from(mid).length > 256)) ||
        (index != null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 65535))) return undefined;
    const mapped: RTCIceCandidateInit & {candidate: string} = {candidate: line};
    if (mid === null || typeof mid === 'string') mapped.sdpMid = mid;
    if (index === null || typeof index === 'number') mapped.sdpMLineIndex = index;
    if (username === null || typeof username === 'string') mapped.usernameFragment = username;
    const identity = {ufrag, mid: typeof mid === 'string' ? mid : undefined, index: typeof index === 'number' ? index : undefined};
    if (typeof mid === 'string') return {candidate: {...mapped, sdpMid: mid}, identity};
    if (typeof index === 'number') return {candidate: {...mapped, sdpMLineIndex: index}, identity};
    return undefined;
}

export function matchesIceGeneration(identity: IceCandidateIdentity, generations: readonly IceMediaGeneration[]): boolean {
    return generations.some(item => item.ufrag === identity.ufrag &&
        (identity.mid === undefined || item.mid === identity.mid) && (identity.index === undefined || item.index === identity.index));
}

/** Enrich browser candidates without guessing across distinct local generations. */
export function outgoingIceCandidate(value: RTCIceCandidate, installed: readonly IceMediaGeneration[], retired: readonly IceMediaGeneration[]): {kind: 'candidate'; candidate: GroupIceCandidate} | {kind: 'stale' | 'ambiguous'} {
    const json = value.toJSON();
    if (json.candidate != null && json.candidate !== value.candidate) return {kind: 'ambiguous'};
    if (json.sdpMid != null && value.sdpMid != null && json.sdpMid !== value.sdpMid) return {kind: 'ambiguous'};
    if (json.sdpMLineIndex != null && value.sdpMLineIndex != null && json.sdpMLineIndex !== value.sdpMLineIndex) return {kind: 'ambiguous'};
    const mid = json.sdpMid ?? value.sdpMid;
    const index = json.sdpMLineIndex ?? value.sdpMLineIndex;
    const embedded = embeddedUfrags(value.candidate)[0];
    const ufrags = [json.usernameFragment, value.usernameFragment, embedded].filter((item): item is string => item != null);
    if (new Set(ufrags).size > 1 || ufrags.some(item => !item)) return {kind: 'ambiguous'};
    const media = (items: readonly IceMediaGeneration[]): IceMediaGeneration[] => items.filter(item =>
        (mid == null || item.mid === mid) && (index == null || item.index === index));
    if (mid == null && index == null) return {kind: 'ambiguous'};
    const local = media(installed);
    const previous = media(retired);
    const ufrag = ufrags[0] || local[0]?.ufrag;
    if (!ufrag) return {kind: 'ambiguous'};
    const parsed = iceCandidateIdentity({candidate: value.candidate, sdpMid: mid, sdpMLineIndex: index, usernameFragment: ufrag});
    if (!parsed) return {kind: 'ambiguous'};
    if (!matchesIceGeneration(parsed.identity, local)) return matchesIceGeneration(parsed.identity, previous) ? {kind: 'stale'} : {kind: 'ambiguous'};
    const possible = (ufrags.length ? [...local, ...previous].filter(item => item.ufrag === ufrag) : [...local, ...previous]);
    if (new Set(possible.map(item => `${item.ufrag}\u0000${item.password}`)).size !== 1) return {kind: 'ambiguous'};
    return {kind: 'candidate', candidate: parsed.candidate};
}
