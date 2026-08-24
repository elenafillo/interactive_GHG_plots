/**
 * Entry point for explore.html: the explorer on its own, no sound.
 *
 * Everything is in explorer.js, which listen.html mounts too -- with the audio
 * clock hooked in. Ridge Hill is the default here because it is the only export
 * with an emissions inventory, so it is the one where the modelled line exists.
 */

import { mountExplorer } from './explorer.js';

mountExplorer({ defaultData: 'data-rgl/' });
