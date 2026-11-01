import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {SharedModule} from './shared.module';

@Component({standalone: true, imports: [SharedModule], template: `<main class="scroll" style="height:50px;overflow:auto" [zweiPullToRefresh]="enabled" [pullToRefreshBusy]="busy" (pullToRefresh)="refreshes = refreshes + 1"><div class="content" style="height:200px"><button>Action</button><button class="person-option"><span>Chat row</span></button><span>Content</span></div></main>`})
class RefreshHost {
    enabled = true;
    busy = false;
    refreshes = 0;
}

describe('pull to refresh gesture', () => {
    let width: PropertyDescriptor | undefined;
    beforeEach(() => {
        width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 390});
    });
    afterEach(() => { if (width) Object.defineProperty(window, 'innerWidth', width); });

    function touch(target: Element, type: string, x: number, y: number, count = 1): void {
        const event = new Event(type, {bubbles: true, cancelable: true});
        const points = Array.from({length: count}, (_, identifier) => ({identifier, clientX: x, clientY: y}));
        Object.defineProperties(event, {touches: {value: type === 'touchend' || type === 'touchcancel' ? [] : points}, changedTouches: {value: points}});
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    }

    it('refreshes only for a deliberate downward pull at the scroll top', () => {
        const fixture = TestBed.createComponent(RefreshHost);
        fixture.detectChanges();
        const surface = fixture.nativeElement.querySelector('.scroll') as HTMLElement;
        const content = fixture.nativeElement.querySelector('.content') as Element;
        touch(content, 'touchstart', 120, 20);
        touch(content, 'touchmove', 122, 110);
        touch(content, 'touchend', 122, 110);
        expect(fixture.componentInstance.refreshes).toBe(1);

        const row = fixture.nativeElement.querySelector('.person-option span') as Element;
        touch(row, 'touchstart', 120, 20);
        touch(row, 'touchmove', 122, 110);
        touch(row, 'touchend', 122, 110);
        expect(fixture.componentInstance.refreshes).toBe(2);

        surface.scrollTop = 5;
        expect(surface.scrollTop).toBe(5);
        touch(content, 'touchstart', 120, 20);
        touch(content, 'touchend', 120, 120);
        surface.scrollTop = 0;
        touch(content, 'touchstart', 120, 20);
        touch(content, 'touchmove', 220, 20);
        touch(content, 'touchend', 220, 20);
        expect(fixture.componentInstance.refreshes).toBe(2);
        fixture.destroy();
    });

    it('ignores controls, busy state, cancellation, multitouch and desktop', () => {
        const fixture = TestBed.createComponent(RefreshHost);
        fixture.detectChanges();
        const content = fixture.nativeElement.querySelector('.content') as Element;
        const button = fixture.nativeElement.querySelector('button') as Element;
        touch(button, 'touchstart', 120, 20);
        touch(button, 'touchend', 120, 120);
        touch(content, 'touchstart', 120, 20);
        fixture.componentInstance.busy = true;
        fixture.detectChanges();
        touch(content, 'touchend', 120, 120);
        fixture.componentInstance.busy = false;
        fixture.detectChanges();
        touch(content, 'touchstart', 120, 20, 2);
        touch(content, 'touchend', 120, 120, 2);
        touch(content, 'touchstart', 120, 20);
        touch(content, 'touchcancel', 120, 120);
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 1024});
        touch(content, 'touchstart', 120, 20);
        touch(content, 'touchend', 120, 120);
        expect(fixture.componentInstance.refreshes).toBe(0);
        fixture.destroy();
    });
});
