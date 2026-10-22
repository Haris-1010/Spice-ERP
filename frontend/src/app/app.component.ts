import { Component, OnInit } from '@angular/core';
import { Auth } from './core/auth';
import { Sync } from './core/sync';
import { I18n } from './core/i18n';
import { LoginComponent, ShellComponent } from './shell';
import { OverlaysComponent } from './shared/ui';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ShellComponent, LoginComponent, OverlaysComponent],
  template: `
    @if (auth.ready()) {
      @if (auth.session()) { <app-shell /> } @else { <app-login /> }
    }
    <app-overlays />
  `,
})
export class AppComponent implements OnInit {
  constructor(public auth: Auth, private sync: Sync, private i18n: I18n) {}
  async ngOnInit() {
    await this.auth.init();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {}); // ask the browser not to evict offline data
    await this.sync.start();
  }
}
