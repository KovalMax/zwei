import {Directive, ElementRef, EventEmitter, HostListener, Input, OnDestroy, Output} from '@angular/core';

// Leave the outermost 16px to the browser's own edge navigation. Never cancel
// touch events: native scrolling and browser gesture cancellation take priority.
@Directive({selector: '[zweiSwipeBack]', standalone: false})
export class SwipeBackDirective implements OnDestroy {
    @Input() zweiSwipeBack = false;
    @Output() readonly swipeBack = new EventEmitter<void>();
    private start?: {id: number; x: number; y: number; time: number};
    private expiry?: number;
    private endCleanup?: number;
    private readonly observeTouches = (event: TouchEvent): void => {
        if (this.start && (event.touches.length !== 1 || event.touches[0].identifier !== this.start.id)) this.clearGesture();
    };
    private readonly observeEnd = (): void => {
        const start = this.start;
        // The host handles its own touchend first; an end outside the host or
        // stopped propagation still releases the temporary document listeners.
        this.endCleanup = window.setTimeout(() => { if (start && this.start === start) this.clearGesture(); }, 0);
    };
    private readonly observeCancel = (): void => this.clearGesture();

    constructor(private readonly host: ElementRef<HTMLElement>) {}

    @HostListener('touchstart', ['$event'])
    public onStart(event: TouchEvent): void {
        this.clearGesture();
        if (!this.available() || event.touches.length !== 1 || !(event.target instanceof Element)) return;
        if (event.target.closest('button, a, input, textarea, select, [contenteditable], [role="button"], [role="dialog"], [role="menu"]')) return;
        if (this.hasHorizontalScroller(event.target)) return;
        const touch = event.touches[0];
        if (touch.clientX < 16 || touch.clientX > 40) return;
        this.start = {id: touch.identifier, x: touch.clientX, y: touch.clientY, time: Date.now()};
        this.expiry = window.setTimeout(() => this.clearGesture(), 1001);
        document.addEventListener('touchstart', this.observeTouches, {capture: true, passive: true});
        document.addEventListener('touchmove', this.observeTouches, {capture: true, passive: true});
        document.addEventListener('touchend', this.observeEnd, {capture: true, passive: true});
        document.addEventListener('touchcancel', this.observeCancel, {capture: true, passive: true});
    }

    @HostListener('touchmove', ['$event'])
    public onMove(event: TouchEvent): void {
        if (!this.start) return;
        const touch = event.touches[0];
        if (event.touches.length !== 1 || touch.identifier !== this.start.id || !this.available()) {
            this.clearGesture();
            return;
        }
        const dx = touch.clientX - this.start.x;
        const dy = Math.abs(touch.clientY - this.start.y);
        if (dx < -10 || (dy > 12 && dy > Math.max(0, dx))) this.clearGesture();
    }

    @HostListener('touchend', ['$event'])
    public onEnd(event: TouchEvent): void {
        const start = this.start;
        this.clearGesture();
        if (!start || !this.available() || event.touches.length !== 0 || event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - start.x;
        const dy = Math.abs(touch.clientY - start.y);
        if (touch.identifier === start.id && dx >= 80 && dy <= 40 && dx >= dy * 2 && Date.now() - start.time <= 1000) this.swipeBack.emit();
    }

    @HostListener('touchcancel')
    public onCancel(): void { this.clearGesture(); }

    public ngOnDestroy(): void { this.clearGesture(); }

    private clearGesture(): void {
        if (!this.start) return;
        this.start = undefined;
        window.clearTimeout(this.expiry);
        this.expiry = undefined;
        window.clearTimeout(this.endCleanup);
        this.endCleanup = undefined;
        document.removeEventListener('touchstart', this.observeTouches, true);
        document.removeEventListener('touchmove', this.observeTouches, true);
        document.removeEventListener('touchend', this.observeEnd, true);
        document.removeEventListener('touchcancel', this.observeCancel, true);
    }

    private available(): boolean {
        return this.zweiSwipeBack && window.innerWidth <= 760 && !document.querySelector('.cdk-overlay-pane');
    }

    private hasHorizontalScroller(target: Element): boolean {
        for (let element: Element | null = target; element; element = element.parentElement) {
            if (element.scrollWidth > element.clientWidth && /^(auto|scroll)$/.test(getComputedStyle(element).overflowX)) return true;
            if (element === this.host.nativeElement) break;
        }
        return false;
    }
}
