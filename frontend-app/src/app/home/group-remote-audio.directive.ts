import {Directive, ElementRef, HostListener, OnDestroy, OnInit} from '@angular/core';
import {GroupCallFacade} from './group-call-facade.service';

@Directive({
    selector: 'audio[groupRemoteAudio]',
    standalone: false,
})
export class GroupRemoteAudioDirective implements OnInit, OnDestroy {
    public constructor(private readonly element: ElementRef<HTMLAudioElement>, private readonly groupCall: GroupCallFacade) {}

    public ngOnInit(): void {
        this.groupCall.registerRemoteAudio(this.element.nativeElement);
    }

    @HostListener('loadedmetadata')
    @HostListener('canplay')
    public playWhenReady(): void { this.groupCall.playRemoteAudio(this.element.nativeElement); }

    public ngOnDestroy(): void {
        this.groupCall.unregisterRemoteAudio(this.element.nativeElement);
    }
}
