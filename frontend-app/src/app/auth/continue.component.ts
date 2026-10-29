import {ChangeDetectorRef, Component, OnDestroy, OnInit} from '@angular/core';
import {Router} from '@angular/router';
import {Subject} from 'rxjs';
import {takeUntil} from 'rxjs/operators';
import {AuthService} from './auth.service';
import {BrowserSessionCandidate, BrowserSessionClient} from './browser-session.client';
import {HostService} from './host.service';

@Component({
    selector: 'app-continue',
    standalone: false,
    templateUrl: './continue.component.html',
    styleUrls: ['./auth-surface.css', './continue.component.css'],
})
export class ContinueComponent implements OnInit, OnDestroy {
    candidates: BrowserSessionCandidate[] = [];
    loading = false;
    error = '';
    private readonly destroyed = new Subject<void>();

    constructor(private client: BrowserSessionClient, private auth: AuthService,
                private host: HostService, private router: Router, private changeDetector: ChangeDetectorRef) {}

    ngOnInit(): void {
        this.discover();
    }

    discover(): void {
        if (this.loading) return;
        this.loading = true;
        this.error = '';
        this.candidates = [];
        this.client.discover(this.host.browserSessionEndpoints()).pipe(takeUntil(this.destroyed)).subscribe({
            next: result => { this.candidates = result.candidates; this.loading = false; this.changeDetector.markForCheck(); },
            error: error => {
                this.loading = false;
                this.error = error.status === 401 ? '' : 'Could not find saved sessions. Please try again.';
                this.changeDetector.markForCheck();
            },
        });
    }

    continue(candidate: BrowserSessionCandidate): void {
        if (this.loading) return;
        this.loading = true;
        this.error = '';
        this.client.continue(this.host.browserSessionEndpoints(), candidate).pipe(takeUntil(this.destroyed)).subscribe({
            next: session => {
                this.loading = false;
                try {
                    this.auth.acceptToken(session);
                } catch {
                    this.candidates = [];
                    this.error = 'Could not continue this session. Find saved sessions again or sign in.';
                    this.changeDetector.markForCheck();
                    return;
                }
                void this.router.navigate([this.auth.defaultAuthenticatedRoute()]);
            },
            error: () => { this.loading = false; this.candidates = []; this.error = 'Could not continue this session. Find saved sessions again or sign in.'; this.changeDetector.markForCheck(); },
        });
    }

    ngOnDestroy(): void { this.destroyed.next(); this.destroyed.complete(); }
}
