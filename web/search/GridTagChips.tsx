import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { getItemListsSync, getListsSync } from "../lists/lists";
import { gridTagChip } from "../styles";

// One chip per list the item belongs to, rendered as plain flow children
// (a fragment) so the parent corner slot owns the layout — see
// styles.ts cellCornerTR. Membership is read from `listMemberships` so the
// row updates the moment AddToList writes. Empty memberships render
// nothing — zero DOM cost for un-listed videos, which is most of them.
@observer
export class GridTagChips extends preact.Component<{ itemKey: string }> {
    render() {
        const memberKeys = getItemListsSync(this.props.itemKey);
        if (memberKeys.size === 0) return null;
        const allLists = getListsSync();
        const tagged = allLists.filter(l => memberKeys.has(l.key));
        if (tagged.length === 0) return null;
        return <>
            {tagged.map(l => <div
                key={l.key}
                className={gridTagChip}
                title={`In list: ${l.name}`}
            >
                {l.name}
            </div>)}
        </>;
    }
}
