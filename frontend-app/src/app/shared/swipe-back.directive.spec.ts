import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {SharedModule} from './shared.module';

@Component({standalone: true, imports: [SharedModule], template: `<main [zweiSwipeBack]="enabled" (swipeBack)="backs = backs + 1"><div class="surface"><input><div class="horizontal" style="width:50px;overflow-x:auto"><div style="width:300px">Scrollable content</div></div></div></main>`})
class GestureHost {
    enabled = true;
    backs = 0;
}

describe('edge swipe back', () => {
    let originalWidth: PropertyDescriptor | undefined;

    beforeEach(() => {
        originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 390});
    });
    afterEach(() => {
        if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
    });

    function touch(target: Element, type: string, x: number, y: number, count = 1): Event {
        const event = new Event(type, {bubbles: true, cancelable: true});
        const points = Array.from({length: count}, (_, identifier) => ({identifier, clientX: x, clientY: y}));
        Object.defineProperties(event, {touches: {value: type === 'touchend' || type === 'touchcancel' ? [] : points}, changedTouches: {value: points}});
        target.dispatchEvent(event);
        return event;
    }

    it('recognizes a deliberate rightward swipe without cancelling browser events', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        expect(touch(surface, 'touchstart', 25, 100).defaultPrevented).toBe(false);
        expect(touch(surface, 'touchmove', 100, 105).defaultPrevented).toBe(false);
        expect(touch(surface, 'touchend', 125, 108).defaultPrevented).toBe(false);
        expect(fixture.componentInstance.backs).toBe(1);
    });

    it('cancels when a second finger touches outside the host, even if it lifts before the first', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        const first = {identifier: 0, clientX: 25, clientY: 100};
        const second = {identifier: 1, clientX: 250, clientY: 20};
        const dispatch = (target: Element, type: string, touches: object[], changedTouches: object[]) => {
            const event = new Event(type, {bubbles: true, cancelable: true});
            Object.defineProperties(event, {touches: {value: touches}, changedTouches: {value: changedTouches}});
            target.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(false);
        };
        dispatch(surface, 'touchstart', [first], [first]);
        dispatch(document.body, 'touchstart', [first, second], [second]);
        dispatch(document.body, 'touchend', [first], [second]);
        const moved = {...first, clientX: 125};
        dispatch(surface, 'touchmove', [moved], [moved]);
        dispatch(surface, 'touchend', [], [moved]);
        expect(fixture.componentInstance.backs).toBe(0);
    });

    it('enforces edge, distance, direction, time and cancellation boundaries', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        let now = 0;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const swipe = (x: number, dx: number, dy: number, elapsed = 500) => {
                now = 0;
                touch(surface, 'touchstart', x, 100);
                now = elapsed;
                touch(surface, 'touchmove', x + dx, 100 + dy);
                touch(surface, 'touchend', x + dx, 100 + dy);
            };
            swipe(15, 80, 0); swipe(41, 80, 0); swipe(16, 79, 0);
            swipe(16, 80, 41); swipe(16, 80, 0, 1001);
            expect(fixture.componentInstance.backs).toBe(0);
            swipe(16, 80, 40, 1000); swipe(40, 80, 0);
            expect(fixture.componentInstance.backs).toBe(2);
            touch(surface, 'touchstart', 25, 100);
            touch(surface, 'touchmove', 10, 100);
            touch(surface, 'touchend', 125, 100);
            touch(surface, 'touchstart', 25, 100);
            touch(surface, 'touchmove', 30, 120);
            touch(surface, 'touchend', 125, 100);
            expect(fixture.componentInstance.backs).toBe(2);
        } finally { clock.mockRestore(); }
    });

    it('releases temporary document listeners when a gesture ends or its host is destroyed', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        try {
            touch(surface, 'touchstart', 25, 100);
            const added = add.mock.calls.filter(call => call[0] === 'touchstart');
            expect(added).toHaveLength(1);
            touch(surface, 'touchend', 125, 100);
            expect(remove.mock.calls.some(call => call[0] === 'touchstart' && call[1] === added[0][1])).toBe(true);
            touch(surface, 'touchstart', 25, 100);
            const second = add.mock.calls.filter(call => call[0] === 'touchstart')[1];
            fixture.destroy();
            expect(remove.mock.calls.some(call => call[0] === 'touchstart' && call[1] === second[1])).toBe(true);
        } finally { add.mockRestore(); remove.mockRestore(); }
    });

    it('releases global observation if an interrupted gesture never ends', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        vi.useFakeTimers();
        try {
            touch(surface, 'touchstart', 25, 100);
            const listener = add.mock.calls.find(call => call[0] === 'touchstart')?.[1];
            expect(listener).toBeDefined();
            vi.advanceTimersByTime(1001);
            expect(remove.mock.calls.some(call => call[0] === 'touchstart' && call[1] === listener)).toBe(true);
            touch(surface, 'touchend', 125, 100);
            expect(fixture.componentInstance.backs).toBe(0);
        } finally { vi.useRealTimers(); add.mockRestore(); remove.mockRestore(); fixture.destroy(); }
    });

    it('does not navigate if disabled or an overlay opens during the gesture', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        touch(surface, 'touchstart', 25, 100);
        fixture.componentInstance.enabled = false;
        fixture.detectChanges();
        touch(surface, 'touchend', 125, 100);
        fixture.componentInstance.enabled = true;
        fixture.detectChanges();
        touch(surface, 'touchstart', 25, 100);
        const overlay = document.createElement('div');
        overlay.className = 'cdk-overlay-pane';
        document.body.appendChild(overlay);
        try { touch(surface, 'touchend', 125, 100); } finally { overlay.remove(); }
        expect(fixture.componentInstance.backs).toBe(0);
    });

    it('ignores native-edge, middle, vertical, short, cancelled, multitouch, input, disabled and desktop gestures', () => {
        const fixture = TestBed.createComponent(GestureHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.surface') as Element;
        const input = fixture.nativeElement.querySelector('input') as Element;
        const horizontalContent = fixture.nativeElement.querySelector('.horizontal div') as Element;
        const swipe = (target: Element, x: number, y: number, endX: number, endY: number, end = 'touchend', count = 1) => {
            touch(target, 'touchstart', x, y, count);
            touch(target, 'touchmove', endX, endY, count);
            touch(target, end, endX, endY, count);
        };
        swipe(surface, 3, 100, 140, 100);
        swipe(surface, 90, 100, 190, 100);
        swipe(surface, 25, 100, 100, 220);
        swipe(surface, 25, 100, 50, 100);
        swipe(surface, 25, 100, 125, 100, 'touchcancel');
        swipe(surface, 25, 100, 125, 100, 'touchend', 2);
        swipe(input, 25, 100, 125, 100);
        swipe(horizontalContent, 25, 100, 125, 100);
        const overlay = document.createElement('div');
        overlay.className = 'cdk-overlay-pane';
        document.body.appendChild(overlay);
        swipe(surface, 25, 100, 125, 100);
        overlay.remove();
        fixture.componentInstance.enabled = false;
        fixture.detectChanges();
        swipe(surface, 25, 100, 125, 100);
        fixture.componentInstance.enabled = true;
        fixture.detectChanges();
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1024});
        swipe(surface, 25, 100, 125, 100);
        expect(fixture.componentInstance.backs).toBe(0);
    });
});
