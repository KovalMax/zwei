import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ZweiIconComponent} from './zwei-icon.component';

describe('ZweiIconComponent', () => {
    let fixture: ComponentFixture<ZweiIconComponent>;

    beforeEach(() => {
        TestBed.configureTestingModule({declarations: [ZweiIconComponent]});
        fixture = TestBed.createComponent(ZweiIconComponent);
    });

    it('renders the named inline SVG as decorative content', () => {
        fixture.componentRef.setInput('name', 'send');
        fixture.detectChanges();

        const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.querySelector('path')?.getAttribute('d')).toContain('23 12');
    });

    it('renders the compact read-state icon', () => {
        fixture.componentRef.setInput('name', 'done_all');
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('path')?.getAttribute('d')).toContain('20.59 6.41');
    });
});
