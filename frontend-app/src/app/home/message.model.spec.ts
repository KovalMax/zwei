import {messageDateLabel, messageDateTimeLabel} from './message.model';

describe('message date labels', () => {
    const now = new Date('2026-08-18T15:30:00');

    it('labels a message from today without hiding the date context', () => {
        expect(messageDateLabel('2026-08-18T09:15:00', now)).toBe('Today');
    });

    it('labels yesterday separately from older dates', () => {
        expect(messageDateLabel('2026-08-17T23:15:00', now)).toBe('Yesterday');
        expect(messageDateLabel('2026-08-16T23:15:00', now)).toBe(new Intl.DateTimeFormat([], {month: 'short', day: 'numeric', year: 'numeric'}).format(new Date('2026-08-16T23:15:00')));
    });

    it('returns an accessible full date and time title', () => {
        const date = new Date('2026-08-16T23:15:00');
        const expected = `${date.toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'})} ${date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}`;
        expect(messageDateTimeLabel('2026-08-16T23:15:00')).toBe(expected);
        expect(messageDateTimeLabel('not-a-date')).toBe('');
    });
});
