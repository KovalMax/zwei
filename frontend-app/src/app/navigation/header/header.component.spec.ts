import {ComponentFixture, TestBed} from '@angular/core/testing';

import {HeaderComponent} from './header.component';
import {AppModule} from '../../app.module';

describe('HeaderComponent', () => {
    let component: HeaderComponent;
    let fixture: ComponentFixture<HeaderComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [AppModule]
        })
            .compileComponents();
    });

    beforeEach(() => {
        fixture = TestBed.createComponent(HeaderComponent);
        component = fixture.componentInstance;
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('repositions an open account menu on mobile and clears only its mobile positioning overrides on desktop', () => {
        const overlay = document.createElement('div');
        overlay.className = 'cdk-overlay-container';
        const panel = document.createElement('div');
        panel.className = 'mat-mdc-menu-panel';
        panel.style.setProperty('background-color', 'rgb(38, 53, 70)', 'important');
        overlay.append(panel);
        document.body.append(overlay);
        const matchMedia = vi.spyOn(window, 'matchMedia')
            .mockReturnValueOnce({matches: true} as unknown as MediaQueryList)
            .mockReturnValueOnce({matches: false} as unknown as MediaQueryList);

        try {
            component.applyAccountMenuTheme();
            expect(panel.style.getPropertyValue('position')).toBe('fixed');
            expect(panel.style.getPropertyValue('right')).toBe('16px');
            expect(panel.style.getPropertyValue('bottom')).toBe('16px');

            component.onWindowResize();

            for (const property of ['position', 'top', 'right', 'bottom', 'left', 'transform']) {
                expect(panel.style.getPropertyValue(property), `${property} override should be cleared`).toBe('');
            }
            expect(panel.style.getPropertyValue('background-color')).toBe('rgb(38, 53, 70)');
            expect(matchMedia).toHaveBeenCalledTimes(2);
        } finally {
            overlay.remove();
        }
    });
});
