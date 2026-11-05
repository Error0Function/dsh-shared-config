import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
/** Shared cross-process edit lock timing. */
export interface Config {
    lockWaitMs: number;
}
/** Persist native ConfigEditor edits in a file shared by profiles in one DSH home. */
export default class SharedConfigEditor extends ConfigEditor {
    private readonly sharedContext;
    private readonly options;
    static Config: z<Config>;
    constructor(sharedContext: Context, options: Config);
    get documentPath(): string;
    configuration(): ReturnType<ConfigEditor['configuration']>;
    edit(entry: Entry, change: Parameters<ConfigEditor['edit']>[1]): Promise<void>;
}
