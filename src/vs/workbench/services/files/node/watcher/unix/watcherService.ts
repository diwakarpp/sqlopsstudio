/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { getNextTickChannel } from 'vs/base/parts/ipc/common/ipc';
import { Client } from 'vs/base/parts/ipc/node/ipc.cp';
import uri from 'vs/base/common/uri';
import { toFileChangesEvent, IRawFileChange } from 'vs/workbench/services/files/node/watcher/common';
import { IWatcherChannel, WatcherChannelClient } from 'vs/workbench/services/files/node/watcher/unix/watcherIpc';
import { FileChangesEvent } from 'vs/platform/files/common/files';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { normalize } from 'path';

export class FileWatcher {
	private static readonly MAX_RESTARTS = 5;

	private isDisposed: boolean;
	private restartCounter: number;

	constructor(
		private contextService: IWorkspaceContextService,
		private ignored: string[],
		private onFileChanges: (changes: FileChangesEvent) => void,
		private errorLogger: (msg: string) => void,
		private verboseLogging: boolean
	) {
		this.isDisposed = false;
		this.restartCounter = 0;
	}

	public startWatching(): () => void {
		const args = ['--type=watcherService'];

		const client = new Client(
			uri.parse(require.toUrl('bootstrap')).fsPath,
			{
				serverName: 'Watcher',
				args,
				env: {
					AMD_ENTRYPOINT: 'vs/workbench/services/files/node/watcher/unix/watcherApp',
					PIPE_LOGGING: 'true',
					VERBOSE_LOGGING: this.verboseLogging
				}
			}
		);

		const channel = getNextTickChannel(client.getChannel<IWatcherChannel>('watcher'));
		const service = new WatcherChannelClient(channel);

		// Start watching
		const basePath: string = normalize(this.contextService.getWorkspace().folders[0].uri.fsPath);
		service.watch({ basePath: basePath, ignored: this.ignored, verboseLogging: this.verboseLogging }).then(null, err => {
			if (!this.isDisposed && !(err instanceof Error && err.name === 'Canceled' && err.message === 'Canceled')) {
				return TPromise.wrapError(err); // the service lib uses the promise cancel error to indicate the process died, we do not want to bubble this up
			}

			return void 0;
		}, (events: IRawFileChange[]) => this.onRawFileEvents(events)).done(() => {

			// our watcher app should never be completed because it keeps on watching. being in here indicates
			// that the watcher process died and we want to restart it here. we only do it a max number of times
			if (!this.isDisposed) {
				if (this.restartCounter <= FileWatcher.MAX_RESTARTS) {
					this.errorLogger('[FileWatcher] terminated unexpectedly and is restarted again...');
					this.restartCounter++;
					this.startWatching();
				} else {
					this.errorLogger('[FileWatcher] failed to start after retrying for some time, giving up. Please report this as a bug report!');
				}
			}
		}, error => {
			if (!this.isDisposed) {
				this.errorLogger(error);
			}
		});

		return () => {
			this.isDisposed = true;
			client.dispose();
		};
	}

	private onRawFileEvents(events: IRawFileChange[]): void {
		if (this.isDisposed) {
			return;
		}

		// Emit through event emitter
		if (events.length > 0) {
			this.onFileChanges(toFileChangesEvent(events));
		}
	}
}