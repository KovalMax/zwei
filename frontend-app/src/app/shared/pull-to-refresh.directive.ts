import {Directive, ElementRef, EventEmitter, HostListener, Input, OnDestroy, Output} from '@angular/core';

@Directive({selector: '[zweiPullToRefresh]', standalone: false})
export class PullToRefreshDirective implements OnDestroy {
    @Input() zweiPullToRefresh = false;
    @Input() pullToRefreshBusy = false;
    @Output() readonly pullToRefresh = new EventEmitter<void>();
    private start?: {id: number; x: number; y: number};
    private expiry?: number;

    constructor(private readonly host: ElementRef<HTMLElement>) {}

    @HostListener('touchstart', ['$event'])
    public onStart(event: TouchEvent): void {
        this.clear();
        if (!this.available() || event.touches.length !== 1 || !(event.target instanceof Element)) return;
        const interactive = event.target.closest('button, a, input, textarea, select, [contenteditable], [role="button"], [role="dialog"], [role="menu"]');
        if (interactive && !interactive.matches('.person-option')) return;
        if (this.hasNestedScroller(event.target)) return;
        const touch = event.touches[0];
        this.start = {id: touch.identifier, x: touch.clientX, y: touch.clientY};
        this.expiry = window.setTimeout(() => this.clear(), 1500);
    }

    @HostListener('touchmove', ['$event'])
    public onMove(event: TouchEvent): void {
        if (!this.start) return;
        const touch = event.touches[0];
        if (event.touches.length !== 1 || touch.identifier !== this.start.id || !this.available() ||
            Math.abs(touch.clientX - this.start.x) > 35 || touch.clientY < this.start.y - 10) this.clear();
    }

    @HostListener('touchend', ['$event'])
    public onEnd(event: TouchEvent): void {
        const start = this.start;
        this.clear();
        if (!start || !this.available() || event.touches.length !== 0 || event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        const dy = touch.clientY - start.y;
        const dx = Math.abs(touch.clientX - start.x);
        if (touch.identifier === start.id && dy >= 75 && dx <= 40 && dy >= dx * 2) this.pullToRefresh.emit();
    }

    @HostListener('touchcancel')
    public onCancel(): void { this.clear(); }

    public ngOnDestroy(): void { this.clear(); }

    private available(): boolean {
        return this.zweiPullToRefresh && !this.pullToRefreshBusy && this.host.nativeElement.scrollTop <= 0 &&
            window.innerWidth <= 760 && !document.querySelector('.cdk-overlay-pane');
    }

    private hasNestedScroller(target: Element): boolean {
        for (let element: Element | null = target; element && element !== this.host.nativeElement; element = element.parentElement) {
            if (element.scrollTop > 0 && element.scrollHeight > element.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)) return true;
        }
        return false;
    }

    private clear(): void {
        this.start = undefined;
        window.clearTimeout(this.expiry);
        this.expiry = undefined;
    }
}
