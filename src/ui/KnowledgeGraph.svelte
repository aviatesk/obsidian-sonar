<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import * as d3 from 'd3';
  import type { SearchResult } from '../EmbeddingSearch';
  import type { App } from 'obsidian';

  export let app: App;
  export let activeFile: string;
  export let results: SearchResult[];
  export let maxNodes: number = 10;

  interface GraphNode extends d3.SimulationNodeDatum {
    id: string;
    size: number;
    isCenter: boolean;
  }

  interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
    source: string | GraphNode;
    target: string | GraphNode;
    strength: number;
  }

  interface NodeMeta {
    filePath: string;
    title?: string;
    score: number;
    chunkCount: number;
    fileSize: number;
  }

  let svgElement: SVGSVGElement;
  let simulation: d3.Simulation<GraphNode, GraphLink> | null = null;
  let g: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let initialized = false;
  let previousActiveFile = '';
  const width = 400;
  const height = 300;
  const baseSize = 12;

  const nodeMeta = new SvelteMap<string, NodeMeta>();

  function updateLabelOpacity(scale: number) {
    if (!g) return;
    const opacity = scale > 1.2 ? Math.min((scale - 1.2) / 0.8, 1) : 0;
    g.selectAll('.labels text').style('opacity', opacity);
  }

  function initGraph() {
    if (!svgElement || initialized) return;

    const svg = d3.select(svgElement);
    g = svg.append('g');

    const nodes: GraphNode[] = [
      { id: 'center', size: baseSize, isCenter: true }
    ];

    for (let i = 0; i < maxNodes; i++) {
      nodes.push({
        id: `slot-${i}`,
        size: 0,
        isCenter: false,
      });
    }

    const links: GraphLink[] = [];

    simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id(d => d.id)
          .distance(d => 30 + (1-d.strength)/1 * 50)
          .strength(0.3)
      )
      .force('charge', d3.forceManyBody().strength(-200))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05))
      .force('collision', d3.forceCollide<GraphNode>().radius(d => Math.max(d.size + 5, 10)))
      .alpha(1)
      .alphaDecay(0.01)
      .velocityDecay(0.2);

    g.append('g').attr('class', 'links');
    g.append('g').attr('class', 'nodes');
    g.append('g').attr('class', 'labels');

    const initialZoom = 1.3;
    const initialTransform = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(initialZoom)
      .translate(-width / 2, -height / 2);

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 3])
      .on('zoom', event => {
        if (g) {
          g.attr('transform', event.transform);
          updateLabelOpacity(event.transform.k);
        }
      });

    g.attr('transform', initialTransform.toString());
    svg.call(zoom).call(zoom.transform, initialTransform);

    simulation.on('tick', updatePositions);

    initialized = true;
  }

  function updateData() {
    if (!g || !simulation) return;

    const activeFileChanged = previousActiveFile !== activeFile;
    previousActiveFile = activeFile;

    nodeMeta.clear();
    nodeMeta.set('center', {
      filePath: activeFile,
      score: 1,
      chunkCount: 0,
      fileSize: 0,
    });

    const limitedResults = results.slice(0, maxNodes);
    const nodes = simulation.nodes();
    const links: GraphLink[] = [];

    const maxFileSize = Math.max(...limitedResults.map(r => r.fileSize), 1);

    for (let i = 0; i < maxNodes; i++) {
      const slotId = `slot-${i}`;
      const result = limitedResults[i];
      const node = nodes.find(n => n.id === slotId);

      if (result && node) {
        const normalizedFileSize = result.fileSize / maxFileSize;
        node.size = baseSize * (0.5 + normalizedFileSize * 0.5);
        nodeMeta.set(slotId, {
          filePath: result.filePath,
          title: result.title,
          score: result.score,
          chunkCount: result.chunkCount,
          fileSize: result.fileSize,
        });
        links.push({
          source: 'center',
          target: slotId,
          strength: result.score,
        });
      } else if (node) {
        node.size = 0;
      }
    }

    const linkForce = simulation.force('link') as d3.ForceLink<GraphNode, GraphLink>;
    if (linkForce) {
      linkForce.links(links);
    }

    nodes.forEach(node => {
      if (activeFileChanged && node.isCenter) {
        const angle = Math.random() * Math.PI * 2;
        const magnitude = 10;
        node.vx = (node.vx || 0) + Math.cos(angle) * magnitude;
        node.vy = (node.vy || 0) + Math.sin(angle) * magnitude;
      } else if (!node.isCenter && node.size > 0) {
        const angle = Math.random() * Math.PI * 2;
        const magnitude = 1.5;
        node.vx = (node.vx || 0) + Math.cos(angle) * magnitude;
        node.vy = (node.vy || 0) + Math.sin(angle) * magnitude;
      }
    });

    updateElements();
    simulation.alpha(0.2).velocityDecay(0.1).restart();
  }

  function updateElements() {
    if (!g || !simulation) return;

    const nodes = simulation.nodes();
    const linkForce = simulation.force('link') as d3.ForceLink<GraphNode, GraphLink>;
    const links = linkForce ? linkForce.links() : [];

    g.select('.links')
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(links, (d: GraphLink) => {
        const sourceId = typeof d.source === 'string' ? d.source : d.source.id;
        const targetId = typeof d.target === 'string' ? d.target : d.target.id;
        return `${sourceId}-${targetId}`;
      })
      .join(
        enter => enter
          .append('line')
          .attr('stroke', 'var(--graph-line)')
          .attr('stroke-opacity', 0.9)
          .attr('stroke-width', d => 1 + d.strength * 2),
        update => update.call(update =>
          update.transition().duration(300).attr('stroke-width', d => 1 + d.strength * 2)
        ),
        exit => exit.call(exit =>
          exit.transition().duration(300).attr('stroke-opacity', 0).remove()
        )
      );

    g.select('.nodes')
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes, (d: GraphNode) => d.id)
      .join(
        enter => enter
          .append('circle')
          .attr('r', d => d.size)
          .attr('fill', d => (d.isCenter ? 'var(--interactive-accent)' : 'var(--graph-node)'))
          .attr('stroke', d => (d.isCenter ? 'var(--background-primary)' : 'none'))
          .attr('stroke-width', d => (d.isCenter ? 3 : 0))
          .attr('opacity', d => (d.size > 0 || d.isCenter ? 1 : 0))
          .on('mouseover', handleMouseOver)
          .on('mouseout', handleMouseOut)
          .on('click', handleClick)
          .call(
            d3
              .drag<SVGCircleElement, GraphNode>()
              .on('start', dragstarted)
              .on('drag', dragged)
              .on('end', dragended) as any
          ),
        update => update.call(update =>
          update
            .transition()
            .duration(300)
            .attr('r', d => d.size)
            .attr('opacity', d => (d.size > 0 || d.isCenter ? 1 : 0))
        )
      );

    g.select('.labels')
      .selectAll<SVGTextElement, GraphNode>('text')
      .data(nodes, (d: GraphNode) => d.id)
      .join(
        enter => enter
          .append('text')
          .attr('font-family', 'var(--font-interface)')
          .attr('font-size', d => (d.isCenter ? '12px' : '10px'))
          .attr('fill', 'var(--text-muted)')
          .attr('text-anchor', 'middle')
          .attr('dy', d => d.size + 15)
          .attr('pointer-events', 'none')
          .style('opacity', 0)
          .text(d => {
            const meta = nodeMeta.get(d.id);
            return meta && meta.title ? meta.title : '';
          }),
        update => update.call(update =>
          update
            .transition()
            .duration(300)
            .attr('font-size', d => (d.isCenter ? '12px' : '10px'))
            .attr('dy', d => d.size + 15)
            .text(d => {
              const meta = nodeMeta.get(d.id);
              return meta && meta.title ? meta.title : '';
            })
        )
      );

    const svg = d3.select(svgElement);
    const currentTransform = d3.zoomTransform(svg.node()!);
    updateLabelOpacity(currentTransform.k);
  }

  function updatePositions() {
    if (!g) return;

    g.select('.links')
      .selectAll<SVGLineElement, GraphLink>('line')
      .attr('x1', d => (d.source as GraphNode).x || 0)
      .attr('y1', d => (d.source as GraphNode).y || 0)
      .attr('x2', d => (d.target as GraphNode).x || 0)
      .attr('y2', d => (d.target as GraphNode).y || 0);

    g.select('.nodes')
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .attr('cx', d => d.x || 0)
      .attr('cy', d => d.y || 0);

    g.select('.labels')
      .selectAll<SVGTextElement, GraphNode>('text')
      .attr('x', d => d.x || 0)
      .attr('y', d => d.y || 0);
  }

  function handleMouseOver(this: SVGCircleElement, _event: MouseEvent, d: GraphNode) {
    if (d.size === 0 && !d.isCenter) return;

    d3.select(this)
      .attr('fill', d.isCenter ? 'var(--interactive-accent)' : 'var(--graph-node-focused)')
      .style('cursor', d.isCenter ? 'default' : 'pointer')
      .transition()
      .duration(200)
      .attr('r', d.size * 1.3);

    if (simulation) {
      simulation.alphaTarget(0.05).restart();
    }

    const meta = nodeMeta.get(d.id);
    if (meta && meta.title) {
      const tooltipText = `${meta.title} (${(meta.score * 100).toFixed(1)}%${meta.chunkCount ? `, ${meta.chunkCount} chunks` : ''})`;

      const svg = d3.select(svgElement);
      svg
        .append('text')
        .attr('class', 'tooltip')
        .attr('x', (d.x || 0) + d.size + 5)
        .attr('y', (d.y || 0) + 5)
        .attr('font-family', 'var(--font-interface)')
        .attr('font-size', '12px')
        .attr('fill', 'var(--text-normal)')
        .text(tooltipText);
    }
  }

  function handleMouseOut(this: SVGCircleElement, _event: MouseEvent, d: GraphNode) {
    if (d.size === 0 && !d.isCenter) return;

    d3.select(this)
      .attr('fill', d.isCenter ? 'var(--interactive-accent)' : 'var(--graph-node)')
      .transition()
      .duration(200)
      .attr('r', d.size);

    if (simulation) {
      simulation.alphaTarget(0);
    }

    const svg = d3.select(svgElement);
    svg.selectAll('.tooltip').remove();
  }

  function handleClick(_event: MouseEvent, d: GraphNode) {
    if (d.isCenter || d.size === 0) return;

    const meta = nodeMeta.get(d.id);
    if (meta) {
      app.workspace.openLinkText(meta.filePath, '', false);
    }
  }

  function dragstarted(event: d3.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>) {
    if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }

  function dragged(event: d3.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }

  function dragended(event: d3.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>) {
    if (!event.active && simulation) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }

  onMount(() => {
    initGraph();
    updateData();
  });

  onDestroy(() => {
    if (simulation) {
      simulation.stop();
    }
  });

  $: if (svgElement && initialized && (activeFile || results)) {
    updateData();
  }
</script>

<svg bind:this={svgElement} {width} {height} class="knowledge-graph"></svg>

<style>
  .knowledge-graph {
    width: 100%;
    height: 300px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-primary);
  }
</style>
