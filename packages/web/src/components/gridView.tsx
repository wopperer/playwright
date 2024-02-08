/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the 'License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import * as React from 'react';
import { ListView } from './listView';
import type { ListViewProps } from './listView';
import './gridView.css';
import { ResizeView } from '@web/shared/resizeView';

export type Sorting<T> = { by: keyof T, negate: boolean };

export type RenderedGridCell = {
  body: React.ReactNode;
  title?: string;
};

export type GridViewProps<T> = Omit<ListViewProps<T>, 'render'> & {
  columns: (keyof T)[],
  columnTitle: (column: keyof T) => string,
  columnWidth: (column: keyof T) => number,
  render: (item: T, column: keyof T, index: number) => RenderedGridCell,
  sorting?: Sorting<T>,
  setSorting?: (sorting: Sorting<T> | undefined) => void,
};

export function GridView<T>(model: GridViewProps<T>) {
  const initialOffsets: number[] = [];
  for (let i = 0; i < model.columns.length - 1; ++i) {
    const column = model.columns[i];
    initialOffsets[i] = (initialOffsets[i - 1] || 0) + model.columnWidth(column);
  }
  const [offsets, setOffsets] = React.useState<number[]>(initialOffsets);

  const toggleSorting = React.useCallback((f: keyof T) => {
    model.setSorting?.({ by: f, negate: model.sorting?.by === f ? !model.sorting.negate : false });
  }, [model]);

  return <div className={`grid-view ${model.name}-grid-view`}>
    <ResizeView
      orientation={'horizontal'}
      offsets={offsets}
      setOffsets={setOffsets}
      resizerColor='var(--vscode-panel-border)'
      resizerWidth={1}
      minColumnWidth={25}>
    </ResizeView>
    <div className='vbox'>
      <div className='grid-view-header'>
        {model.columns.map((column, i) => {
          return <div
            className={'grid-view-header-cell ' + sortingHeader(column, model.sorting)}
            style={{
              width: offsets[i] - (offsets[i - 1] || 0),
            }}
            onClick={() => model.setSorting && toggleSorting(column)}
          >
            <span className='grid-view-header-cell-title'>{model.columnTitle(column)}</span>
            <span className='codicon codicon-triangle-up' />
            <span className='codicon codicon-triangle-down' />
          </div>;
        })}
      </div>
      <ListView
        name={model.name}
        items={model.items}
        id={model.id}
        render={(item, index) => {
          return <>
            {model.columns.map((column, i) => {
              const { body, title } = model.render(item, column, index);
              return <div
                className={`grid-view-cell grid-view-column-${String(column)}`}
                title={title}
                style={{ width: offsets[i] - (offsets[i - 1] || 0) }}>
                {body}
              </div>;
            })}
          </>;
        }}
        icon={model.icon}
        indent={model.indent}
        isError={model.isError}
        isWarning={model.isWarning}
        isInfo={model.isInfo}
        selectedItem={model.selectedItem}
        onAccepted={model.onAccepted}
        onSelected={model.onSelected}
        onLeftArrow={model.onLeftArrow}
        onRightArrow={model.onRightArrow}
        onHighlighted={model.onHighlighted}
        onIconClicked={model.onIconClicked}
        noItemsMessage={model.noItemsMessage}
        dataTestId={model.dataTestId}
        noHighlightOnHover={model.noHighlightOnHover}
      ></ListView>
    </div>
  </div>;
}

function sortingHeader<T>(column: keyof T, sorting: Sorting<T> | undefined) {
  return column === sorting?.by ? ' filter-' + (sorting.negate ? 'negative' : 'positive') : '';
}
