import {ComponentFixture, TestBed} from '@angular/core/testing';
import {CommonModule} from '@angular/common';
import {AppNoticeComponent} from './app-notice.component';

describe('AppNoticeComponent', () => {
    let fixture: ComponentFixture<AppNoticeComponent>;
    let component: AppNoticeComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [CommonModule], declarations: [AppNoticeComponent]}).compileComponents();
        fixture = TestBed.createComponent(AppNoticeComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('message', 'Could not save your settings.');
        fixture.detectChanges();
    });

    it('presents recoverable errors persistently as alerts without clipping the message', () => {
        fixture.componentRef.setInput('kind', 'error');
        fixture.detectChanges();
        const notice = fixture.nativeElement.querySelector('.app-notice') as HTMLElement;
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.getAttribute('aria-live')).toBe('assertive');
        expect(notice.textContent).toContain('Could not save your settings.');
        expect(notice.querySelector('button')).toBeNull();
    });

    it('uses a polite status for non-error notices and exposes an actionable keyboard button', () => {
        fixture.componentRef.setInput('kind', 'warning');
        fixture.componentRef.setInput('actionLabel', 'Retry');
        const action = vi.fn();
        component.action.subscribe(action);
        fixture.detectChanges();

        const notice = fixture.nativeElement.querySelector('.app-notice') as HTMLElement;
        const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
        expect(notice.getAttribute('role')).toBe('status');
        expect(notice.getAttribute('aria-live')).toBe('polite');
        expect(button.textContent?.trim()).toBe('Retry');
        button.focus();
        expect(document.activeElement).toBe(button);
        button.click();
        expect(action).toHaveBeenCalledOnce();
    });

    it('exposes an opt-in compact layout without changing the accessible notice role', () => {
        fixture.componentRef.setInput('kind', 'error');
        fixture.componentRef.setInput('compact', true);
        fixture.componentRef.setInput('actionLabel', 'Close');
        fixture.detectChanges();

        const notice = fixture.nativeElement.querySelector('.app-notice') as HTMLElement;
        expect(notice.classList.contains('app-notice-compact')).toBe(true);
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.querySelector('button')?.textContent?.trim()).toBe('Close');
    });

    it('maps each notice kind to its requested announcement urgency', () => {
        for (const kind of ['info', 'success', 'warning'] as const) {
            fixture.componentRef.setInput('kind', kind);
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('.app-notice')?.getAttribute('role')).toBe('status');
            expect(fixture.nativeElement.querySelector('.app-notice')?.getAttribute('aria-live')).toBe('polite');
        }
        fixture.componentRef.setInput('kind', 'error');
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.app-notice')?.getAttribute('role')).toBe('alert');
        expect(fixture.nativeElement.querySelector('.app-notice')?.getAttribute('aria-live')).toBe('assertive');
    });

    it('contains wrapped copy and the retry action in a narrow panel in both theme contexts', () => {
        fixture.nativeElement.style.width = '320px';
        fixture.componentRef.setInput('kind', 'error');
        fixture.componentRef.setInput('message', 'Could not save your settings because this is a deliberately long recoverable error message that must wrap without forcing the panel wider.');
        fixture.componentRef.setInput('actionLabel', 'Retry saving settings');
        fixture.detectChanges();
        const notice = fixture.nativeElement.querySelector('.app-notice') as HTMLElement;
        const button = notice.querySelector('button') as HTMLButtonElement;
        const noticeRect = notice.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
        expect(buttonRect.left).toBeGreaterThanOrEqual(noticeRect.left);
        expect(buttonRect.right).toBeLessThanOrEqual(noticeRect.right);

        const lightBorder = getComputedStyle(notice).borderLeftColor;
        document.body.classList.add('dark-theme');
        fixture.detectChanges();
        const darkBorder = getComputedStyle(notice).borderLeftColor;
        document.body.classList.remove('dark-theme');
        expect(darkBorder).not.toBe(lightBorder);
        expect(button.getAttribute('type')).toBe('button');
    });
});
