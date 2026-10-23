import {ChangeDetectionStrategy, Component, Input} from '@angular/core';
import {parseGiphyMedia} from './giphy-media';

@Component({
    standalone: false,
    selector: 'app-inline-giphy',
    template: `<div class="inline-giphy" *ngIf="media as item">
        <a [href]="originalURL" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open original GIPHY link</a>
        <p *ngIf="!enabled && item.kind === 'image'" role="status">GIPHY media is disabled by the administrator.</p>
        <p *ngIf="item.kind === 'share-link'">GIPHY share links open on GIPHY. Following this link contacts GIPHY and may disclose your IP address and request timing.</p>
        <ng-container *ngIf="enabled && item.kind === 'image'">
            <button *ngIf="!loaded && !autoLoad" type="button" (click)="load()">Load GIPHY media</button>
            <p *ngIf="!loaded && !autoLoad">Your browser will contact GIPHY, which may receive your IP address and request timing.</p>
            <img *ngIf="loaded && item.kind === 'image' && !failed" [src]="item.source" alt="GIPHY media" loading="lazy" crossorigin="anonymous" referrerpolicy="no-referrer" (error)="failed = true">
            <p *ngIf="failed" role="status">Media could not be loaded. Use the original link above or retry loading it.</p>
            <button *ngIf="failed" type="button" aria-label="Retry loading GIPHY media" (click)="retry()">Retry loading media</button>
        </ng-container>
    </div>`,
    styles: [`.inline-giphy { display:grid; gap:8px; max-width:100%; overflow-wrap:anywhere; } .inline-giphy a { width:fit-content; max-width:100%; color:var(--chat-text-strong,#172033); text-underline-offset:2px; } :host-context(.message-own) .inline-giphy a { color:var(--chat-message-link-own,#fff); } .inline-giphy a:focus-visible,.inline-giphy button:focus-visible { outline:2px solid var(--zwei-focus,#146bd1); outline-offset:2px; } .inline-giphy img { display:block; width:auto; height:auto; max-width:min(100%, 420px); max-height:320px; border:0; border-radius:10px; object-fit:contain; } .inline-giphy button { width:fit-content; max-width:100%; min-height:40px; padding:7px 12px; border:1px solid var(--chat-line-strong,#526174); border-radius:8px; background:var(--chat-surface-control,#fff); color:var(--chat-text-strong,#172033); font:600 13px 'DM Sans',sans-serif; cursor:pointer; } .inline-giphy p { margin:0; font-size:12px; }`],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InlineGiphyComponent {
    @Input({required: true}) originalURL = '';
    @Input() enabled = false;
    @Input() autoLoad = false;
    public failed = false;
    get media() { return parseGiphyMedia(this.originalURL); }
    get loaded(): boolean { return this.enabled && (this.autoLoad || this.userRequested); }
    private userRequested = false;
    public load(): void { this.userRequested = true; }
    public retry(): void { this.failed = false; this.userRequested = true; }
}
