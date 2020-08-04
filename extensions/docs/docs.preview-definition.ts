import { PreviewDefinition } from '@teambit/preview/preview-definition';
import { ComponentMap, Component } from '@teambit/component';
import { ExecutionContext } from '@teambit/environments';
import { DocsExtension } from './docs.extension';
import { AbstractVinyl } from 'bit-bin/consumer/component/sources';

export class DocsPreviewDefinition implements PreviewDefinition {
  readonly prefix = 'overview';

  constructor(
    /**
     * docs extension.
     */
    private docs: DocsExtension
  ) {}

  async renderTemplatePath(context: ExecutionContext): Promise<string> {
    return this.docs.getTemplate(context);
  }

  async getModuleMap(components: Component[]): Promise<ComponentMap<AbstractVinyl[]>> {
    const map = this.docs.getDocsMap(components);
    return map.filter((value) => value.length !== 0);
  }
}
