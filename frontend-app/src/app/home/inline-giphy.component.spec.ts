import {ComponentFixture, TestBed} from '@angular/core/testing';
import {CommonModule} from '@angular/common';
import {InlineGiphyComponent} from './inline-giphy.component';

describe('InlineGiphyComponent', () => {
    let fixture: ComponentFixture<InlineGiphyComponent>;
    beforeEach(async () => {
        await TestBed.configureTestingModule({
            declarations: [InlineGiphyComponent],
            imports: [CommonModule],
        }).compileComponents();
        fixture = TestBed.createComponent(InlineGiphyComponent);
        fixture.componentInstance.originalURL = 'https://media1.giphy.com/media/abc123/200.gif?x=1';
        fixture.componentInstance.enabled = true;
        fixture.detectChanges();
    });

    it('keeps the source link available and does not request media until clicked', () => {
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
        const link = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
        expect(link.href).toBe('https://media1.giphy.com/media/abc123/200.gif?x=1');
        link.closest('.inline-giphy')?.querySelector('button')?.dispatchEvent(new Event('click'));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('fails closed when policy is disabled', () => {
        fixture.componentRef.setInput('enabled', false);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
        expect(fixture.nativeElement.querySelector('button')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('disabled by the administrator');
    });

    it('keeps a recognized share page as a clickable link without creating an iframe', () => {
        fixture.componentRef.setInput('originalURL', 'https://giphy.com/gifs/dancing-cat-YsTs5ltWtEhnq');
        fixture.detectChanges();
        const link = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
        expect(link.href).toBe('https://giphy.com/gifs/dancing-cat-YsTs5ltWtEhnq');
        expect(fixture.nativeElement.querySelector('button')).toBeNull();
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('share links open on GIPHY');
    });

    it('keeps send-independent media failure visible with the original URL available', () => {
        fixture.componentRef.setInput('autoLoad', true);
        fixture.detectChanges();
        const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
        image.dispatchEvent(new Event('error'));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent).toContain('Media could not be loaded');
        expect((fixture.nativeElement.querySelector('a') as HTMLAnchorElement).href).toBe(fixture.componentInstance.originalURL);
        expect(fixture.nativeElement.querySelector('img')).toBeNull();
    });

    it('offers an explicit retry after an image failure without retrying automatically', () => {
        fixture.componentRef.setInput('autoLoad', true);
        fixture.detectChanges();
        const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
        image.dispatchEvent(new Event('error'));
        fixture.detectChanges();
        const retry = fixture.nativeElement.querySelector('button[aria-label="Retry loading GIPHY media"]') as HTMLButtonElement;
        expect(retry).not.toBeNull();
        expect(fixture.nativeElement.querySelector('img')).toBeNull();

        retry.click();
        fixture.detectChanges();
        const retriedImage = fixture.nativeElement.querySelector('img') as HTMLImageElement;
        expect(retriedImage).not.toBeNull();
        retriedImage.dispatchEvent(new Event('error'));
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('img')).toHaveLength(0);
        expect(fixture.nativeElement.querySelectorAll('button[aria-label="Retry loading GIPHY media"]')).toHaveLength(1);
    });

});
