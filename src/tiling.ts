// @ts-ignore
const Me = imports.misc.extensionUtils.getCurrentExtension();

import * as Lib from 'lib';
import * as Tags from 'tags';
// import * as Log from 'log';
import * as GrabOp from 'grab_op';
import * as Rect from 'rectangle';
import * as window from 'window';
import * as shell from 'shell';

import type { Entity } from './ecs';
import type { Rectangle } from './rectangle';
import type { Ext } from './extension';
import { AutoTiler } from './auto_tiler';

const GLib: GLib = imports.gi.GLib;
const { Meta } = imports.gi;
const Main = imports.ui.main;
const { ShellWindow } = window;

enum Direction {
    Left,
    Up,
    Right,
    Down
}

export class Tiler {
    private keybindings: Object;

    private window: Entity | null = null;
    private swap_window: Entity | null = null;

    constructor(ext: Ext) {
        this.keybindings = {
            "management-orientation": () => {
                if (ext.auto_tiler && this.window) {
                    const window = ext.windows.get(this.window);
                    if (window) {
                        ext.auto_tiler.toggle_orientation(ext);
                        ext.set_overlay(window.rect());
                    }
                }
            },

            "tile-move-left": () => this.move_left(ext),
            "tile-move-down": () => this.move_down(ext),
            "tile-move-up": () => this.move_up(ext),
            "tile-move-right": () => this.move_right(ext),
            "tile-resize-left": () => this.resize(ext, Direction.Left),
            "tile-resize-down": () => this.resize(ext, Direction.Down),
            "tile-resize-up": () => this.resize(ext, Direction.Up),
            "tile-resize-right": () => this.resize(ext, Direction.Right),
            "tile-swap-left": () => this.swap_left(ext),
            "tile-swap-down": () => this.swap_down(ext),
            "tile-swap-up": () => this.swap_up(ext),
            "tile-swap-right": () => this.swap_right(ext),
            "tile-accept": () => this.accept(ext),
            "tile-reject": () => this.exit(ext),
        };
    }

    rect(ext: Ext, monitor: Rectangle): Rectangle | null {
        if (!ext.overlay.visible) return null;

        const columns = monitor.width / ext.column_size;
        const rows = monitor.height / ext.row_size;

        return monitor_rect(monitor, columns, rows);
    }

    change(ext: Ext, overlay: Rectangular, monitor: Rectangle, rect: Rectangle, dx: number, dy: number, dw: number, dh: number): Tiler {
        let changed = new Rect.Rectangle([
            overlay.x + dx * rect.width,
            overlay.y + dy * rect.height,
            overlay.width + dw * rect.width,
            overlay.height + dh * rect.height,
        ]);

        // Align to grid
        changed.x = Lib.round_increment(changed.x - rect.x, rect.width) + rect.x;
        changed.y = Lib.round_increment(changed.y - rect.y, rect.height) + rect.y;
        changed.width = Lib.round_increment(changed.width, rect.width);
        changed.height = Lib.round_increment(changed.height, rect.height);

        // Ensure that width is not too small
        if (changed.width < rect.width) {
            changed.width = rect.width;
        }

        // Ensure that height is not too small
        if (changed.height < rect.height) {
            changed.height = rect.height;
        }

        // Check that corrected rectangle fits on monitors
        let monitors = tile_monitors(changed);

        // Do not use change if there are no matching displays
        if (monitors.length == 0) return this;

        let min_x: number | null = null;
        let min_y: number | null = null;
        let max_x: number | null = null;
        let max_y: number | null = null;

        for (const monitor of monitors) {
            if (min_x === null || monitor.x < min_x) {
                min_x = monitor.x;
            }
            if (min_y === null || monitor.y < min_y) {
                min_y = monitor.y;
            }
            if (max_x === null || (monitor.x + monitor.width) > max_x) {
                max_x = monitor.x + monitor.width;
            }
            if (max_y === null || (monitor.y + monitor.height) < max_y) {
                max_y = monitor.y + monitor.height;
            }
        }

        // Do not use change if maxima cannot be found
        if (min_x === null || min_y === null || max_x === null || max_y === null) {
            return this;
        }

        // Prevent moving too far left
        if (changed.x < min_x) return this;
        // Prevent moving too far right
        if ((changed.x + changed.width) > max_x) return this;
        // Prevent moving too far up
        if (changed.y < min_y) return this;
        // Prevent moving too far down
        if ((changed.y + changed.height) > max_y) return this;

        const left_most = changed.x < ext.column_size;
        const right_most = changed.x + changed.width >= monitor.height - ext.column_size;

        if (left_most && right_most) {
            changed.x += ext.gap_outer;
            changed.width -= (ext.gap_outer * 2);
        } else if (left_most) {
            changed.x += ext.gap_outer;
            changed.width -= ext.gap_inner_half + ext.gap_outer;
        } else if (right_most) {
            changed.x += ext.gap_inner_half;
            changed.width -= ext.gap_inner_half + ext.gap_outer;
        } else {
            changed.x += ext.gap_inner_half;
            changed.width -= ext.gap_inner;
        }

        const top_most = changed.y < ext.row_size;
        const bottom_most = changed.y + changed.height >= monitor.height - ext.row_size;

        if (top_most && bottom_most) {
            changed.y += ext.gap_outer;
            changed.height -= (ext.gap_outer * 2);
        } else if (top_most) {
            changed.y += ext.gap_outer;
            changed.height -= ext.gap_inner_half + ext.gap_outer;
        } else if (bottom_most) {
            changed.y += ext.gap_inner_half;
            changed.height -= ext.gap_inner_half + ext.gap_outer;
        } else {
            changed.y += ext.gap_inner_half;
            changed.height -= ext.gap_inner;
        }

        overlay.x = changed.x;
        overlay.y = changed.y;
        overlay.width = changed.width;
        overlay.height = changed.height;
        return this;
    }

    move(ext: Ext, x: number, y: number, w: number, h: number, focus: () => window.ShellWindow | number | null) {
        if (ext.auto_tiler) {
            this.move_auto(ext, focus());
        } else {
            this.swap_window = null;

            this.rect_by_active_area(ext, (monitor, rect) => {
                this.change(ext, ext.overlay, monitor, rect, x, y, w, h)
                    .change(ext, ext.overlay, monitor, rect, 0, 0, 0, 0);
            });
        }
    }

    move_auto_(ext: Ext, func1: (m: Rectangle, a: Rectangle) => void, func2: (m: Rectangle, a: Rectangle) => void) {
        if (ext.auto_tiler && this.window) {
            const entity = ext.auto_tiler.attached.get(this.window);
            if (entity) {
                const fork = ext.auto_tiler.forest.forks.get(entity);
                const window = ext.windows.get(this.window);

                if (!fork || !window) return;

                const workspace_id = ext.workspace_id(window);

                const toplevel = ext.auto_tiler.forest.find_toplevel(workspace_id);

                if (!toplevel) return;

                const topfork = ext.auto_tiler.forest.forks.get(toplevel);

                if (!topfork) return;

                const toparea = topfork.area as Rect.Rectangle;

                const before = window.rect();

                const work_area = ext.monitor_work_area(workspace_id[0]);

                let resize = (func: (m: Rectangle, a: Rectangle) => void) => {
                    const grab_op = new GrabOp.GrabOp((this.window as Entity), before);

                    let crect = grab_op.rect.clone();
                    func(work_area, crect);

                    crect.clamp_diff(toparea);

                    if (crect.eq(grab_op.rect)) {
                        return;
                    }

                    (ext.auto_tiler as AutoTiler).forest.resize(ext, entity, fork, (this.window as Entity), grab_op.operation(crect), crect);
                };

                resize(func1);
                resize(func2);

                ext.auto_tiler.forest.arrange(ext, fork.workspace);

                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    ext.set_overlay(window.rect());
                    return false;
                });
            }
        }
    }

    rect_by_active_area(ext: Ext, callback: (monitor: Rectangle, area: Rectangle) => void) {
        if (this.window) {
            const monitor_id = ext.monitors.get(this.window);
            if (monitor_id) {
                const monitor = ext.monitor_work_area(monitor_id[0]);
                let rect = this.rect(ext, monitor);

                if (rect) {
                    callback(monitor, rect)
                }
            }
        }
    }

    resize_auto(ext: Ext, direction: Direction) {
        let mov1: Rectangle, mov2: Rectangle;

        const hrow = 64;
        const hcolumn = 64;

        switch (direction) {
            case Direction.Left:
                mov2 = new Rect.Rectangle([hrow, 0, -hrow, 0]);
                mov1 = new Rect.Rectangle([0, 0, -hrow, 0]);
                break;
            case Direction.Right:
                mov1 = new Rect.Rectangle([-hrow, 0, hrow, 0]);
                mov2 = new Rect.Rectangle([0, 0, hrow, 0]);
                break;
            case Direction.Up:
                mov2 = new Rect.Rectangle([0, hcolumn, 0, -hcolumn]);
                mov1 = new Rect.Rectangle([0, 0, 0, -hcolumn]);
                break;
            default:
                mov1 = new Rect.Rectangle([0, -hcolumn, 0, hcolumn]);
                mov2 = new Rect.Rectangle([0, 0, 0, hcolumn]);
        }

        this.move_auto_(
            ext,
            (work_area, crect) => {
                crect.apply(mov1);
                if (crect.x < work_area.x) {
                    crect.width += work_area.x - crect.x;
                }

                if (crect.y < work_area.y) {
                    crect.height += work_area.y - crect.y;
                }
            },
            (work_area, crect) => {
                crect.apply(mov2);
                if (crect.x < work_area.x) {
                    crect.width += work_area.x - crect.x;
                }

                if (crect.y < work_area.y) {
                    crect.height += work_area.y - crect.y;
                }
            }
        );
    }

    move_auto(ext: Ext, move_to: window.ShellWindow | number | null) {
        if (move_to === null) return;

        const focused = ext.focus_window();
        if (ext.auto_tiler && focused) {

            if (move_to instanceof ShellWindow) {
                const parent = ext.auto_tiler.windows_are_siblings(focused.entity, move_to.entity);
                if (parent) {
                    const fork = ext.auto_tiler.forest.forks.get(parent);
                    if (fork) {
                        const temp = fork.left.entity;
                        fork.left.entity = (fork.right as any).entity;
                        (fork.right as any).entity = temp;
                        ext.auto_tiler.tile(ext, fork, fork.area as any);
                        ext.set_overlay(focused.rect());
                        return;
                    }
                }

                ext.auto_tiler.detach_window(ext, focused.entity);
                ext.auto_tiler.attach_to_window(ext, move_to, focused, Lib.cursor_rect());
                ext.set_overlay(focused.rect());
            } else {
                global.log(`attach to monitor ${move_to}`);
                ext.auto_tiler.detach_window(ext, focused.entity);
                ext.auto_tiler.attach_to_monitor(ext, focused, [move_to, ext.active_workspace()]);
            }
        }
    }

    move_left(ext: Ext) {
        this.move(ext, -1, 0, 0, 0, move_window_or_monitor(
            ext,
            ext.focus_selector.left,
            Meta.DisplayDirection.LEFT
        ));
    }

    move_down(ext: Ext) {
        this.move(ext, 0, 1, 0, 0, move_window_or_monitor(
            ext,
            ext.focus_selector.down,
            Meta.DisplayDirection.DOWN
        ));
    }

    move_up(ext: Ext) {
        this.move(ext, 0, -1, 0, 0, move_window_or_monitor(
            ext,
            ext.focus_selector.up,
            Meta.DisplayDirection.UP
        ));
    }

    move_right(ext: Ext) {
        this.move(ext, 1, 0, 0, 0, move_window_or_monitor(
            ext,
            ext.focus_selector.right,
            Meta.DisplayDirection.RIGHT
        ));
    }

    resize(ext: Ext, direction: Direction) {
        if (ext.auto_tiler) {
            this.resize_auto(ext, direction);
        } else {
            let array: [number, number, number, number];
            switch (direction) {
                case Direction.Down:
                    array = [0, 0, 0, 1];
                    break
                case Direction.Left:
                    array = [0, 0, -1, 0];
                    break
                case Direction.Up:
                    array = [0, 0, 0, -1];
                    break
                default:
                    array = [0, 0, 1, 0];
            }

            const [x, y, w, h] = array;

            this.swap_window = null;
            this.rect_by_active_area(ext, (monitor, rect) => {
                this.change(ext, ext.overlay, monitor, rect, x, y, w, h)
                    .change(ext, ext.overlay, monitor, rect, 0, 0, 0, 0);
            });
        }
    }

    swap(ext: Ext, selector: window.ShellWindow | null) {
        if (selector) {
            ext.set_overlay(selector.rect());
            this.swap_window = selector.entity;
        }
    }

    swap_left(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.left(ext, window));
            });
        } else {
            this.swap(ext, ext.focus_selector.left(ext, null));
        }
    }

    swap_down(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.down(ext, window));
            });
        } else {
            this.swap(ext, ext.focus_selector.down(ext, null));
        }
    }

    swap_up(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.up(ext, window));
            })
        } else {
            this.swap(ext, ext.focus_selector.up(ext, null));
        }
    }

    swap_right(ext: Ext) {
        if (this.swap_window) {
            ext.windows.with(this.swap_window, (window) => {
                this.swap(ext, ext.focus_selector.right(ext, window));
            });
        } else {
            this.swap(ext, ext.focus_selector.right(ext, null));
        }
    }

    enter(ext: Ext) {
        if (!this.window) {
            const win = ext.focus_window();
            if (!win) return;

            this.window = win.entity;

            if (win.is_maximized()) {
                win.meta.unmaximize(Meta.MaximizeFlags.BOTH);
            }

            // Set overlay to match window
            ext.set_overlay(win.rect());
            ext.overlay.visible = true;

            if (!ext.auto_tiler) {
                // Make sure overlay is valid
                this.rect_by_active_area(ext, (monitor, rect) => {
                    this.change(ext, ext.overlay, monitor, rect, 0, 0, 0, 0);
                });
            }

            ext.keybindings.disable(ext.keybindings.window_focus)
                .enable(this.keybindings);
        }
    }

    accept(ext: Ext) {
        if (this.window) {
            const meta = ext.windows.get(this.window);
            if (meta) {
                if (this.swap_window) {
                    const meta_swap = ext.windows.get(this.swap_window);
                    if (meta_swap) {
                        if (ext.auto_tiler) {
                            ext.auto_tiler.attach_swap(this.swap_window, this.window);
                        }
                        meta_swap.move(meta.rect());
                        this.swap_window = null;
                    }
                }

                meta.move(ext.overlay);
                ext.add_tag(this.window, Tags.Tiled);
            }
        }

        this.exit(ext);
    }

    exit(ext: Ext) {
        if (this.window) {
            this.window = null;

            // Disable overlay
            ext.overlay.visible = false;

            // Disable tiling keybindings
            ext.keybindings.disable(this.keybindings)
                .enable(ext.keybindings.window_focus);
        }
    }

    snap(ext: Ext, win: window.ShellWindow) {
        let mon_geom = ext.monitor_work_area(win.meta.get_monitor());
        if (mon_geom) {
            let rect = win.rect();
            const columns = mon_geom.width / ext.column_size;
            const rows = mon_geom.height / ext.row_size;
            this.change(
                ext,
                rect,
                mon_geom,
                monitor_rect(mon_geom, columns, rows),
                0, 0, 0, 0
            );

            win.move(rect);

            ext.snapped.insert(win.entity, true);
        }
    }
};

function locate_monitor(ext: Ext, direction: Meta.DisplayDirection): number | null {
    return shell.monitor_neighbor_index(ext.active_monitor(), direction);
}

function monitor_rect(monitor: Rectangle, columns: number, rows: number): Rectangle {
    let tile_width = monitor.width / columns;
    let tile_height = monitor.height / rows;

    // Anything above 21:9 is considered ultrawide
    if (monitor.width * 9 >= monitor.height * 21) {
        tile_width /= 2;
    }

    // Anything below 9:21 is probably a rotated ultrawide
    if (monitor.height * 9 >= monitor.width * 21) {
        tile_height /= 2;
    }

    return new Rect.Rectangle([monitor.x, monitor.y, tile_width, tile_height]);
}

function move_window_or_monitor(ext: Ext, method: any, direction: Meta.DisplayDirection): () => window.ShellWindow | number | null {
    return () => {
        const window = method.call(ext.focus_selector, ext, null);

        return window ?? locate_monitor(ext, direction);
    };
}

function tile_monitors(rect: Rectangle): Array<Rectangle> {
    let total_size = (a: Rectangle, b: Rectangle): number => (a.width * a.height) - (b.width * b.height);

    let workspace = global.workspace_manager.get_active_workspace();
    return Main.layoutManager.monitors
        .map((_monitor: Rectangle, i: number) => workspace.get_work_area_for_monitor(i))
        .filter((monitor: Rectangle) => {
            return (rect.x + rect.width) > monitor.x &&
                (rect.y + rect.height) > monitor.y &&
                rect.x < (monitor.x + monitor.width) &&
                rect.y < (monitor.y + monitor.height);
        })
        .sort(total_size);
}
