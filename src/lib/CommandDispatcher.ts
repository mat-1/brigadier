import ParseResults from "./ParseResults"
import ResultConsumer from "./ResultConsumer"
import RedirectModifier from "./RedirectModifier"
import AmbiguityConsumer from "./AmbiguityConsumer"
import LiteralArgumentBuilder from "./builder/LiteralArgumentBuilder"
import CommandContext from "./context/CommandContext"
import CommandContextBuilder from "./context/CommandContextBuilder"
import SuggestionContext from "./context/SuggestionContext"
import CommandSyntaxException from "./exceptions/CommandSyntaxException"
import Suggestions from "./suggestion/Suggestions"
import SuggestionsBuilder from "./suggestion/SuggestionsBuilder"
import CommandNode from "./tree/CommandNode"
import LiteralCommandNode from "./tree/LiteralCommandNode"
import RootCommandNode from "./tree/RootCommandNode"
import StringReader from "./StringReader";

const ARGUMENT_SEPARATOR = " ";    
const USAGE_OPTIONAL_OPEN = "[";
const USAGE_OPTIONAL_CLOSE = "]";
const USAGE_REQUIRED_OPEN = "(";
const USAGE_REQUIRED_CLOSE = ")";
const USAGE_OR = "|";

export default class CommandDispatcher<S> {    
    
    private root: RootCommandNode<S>;
    
    private consumer: ResultConsumer<S> = {
		onCommandComplete(){}
	};
    
    public constructor (root: RootCommandNode<S> = null) {
        this.root = root || new RootCommandNode<S>();
    }
    
    public register(command: LiteralArgumentBuilder<S>): LiteralCommandNode<S> {
        let build = command.build();
        this.root.addChild(build);
        return build;
    }
    
    public setConsumer(consumer: ResultConsumer<S>) {
        this.consumer = consumer;
    }
    
    public async execute(input: string | StringReader | ParseResults<S>, source: S = null): Promise<number> {

		if (typeof input === "string")
			input = new StringReader(input);
		
		let parse: ParseResults<S>;
        if (input instanceof StringReader) {
            if (!(source == null))
                parse = this.parse(input, source);            
        } else
			parse = input;		
 
        if (parse.getReader().canRead()) {
            if (parse.getExceptions().size === 1) {
                throw parse.getExceptions().values().next().value;
            }
            else if (parse.getContext().getRange().isEmpty()) {
                throw CommandSyntaxException.BUILT_IN_EXCEPTIONS.dispatcherUnknownCommand().createWithContext(parse.getReader());
            }
            else {
                throw CommandSyntaxException.BUILT_IN_EXCEPTIONS.dispatcherUnknownArgument().createWithContext(parse.getReader());
            }
            
        }
        
        let result = 0;
        let successfulForks = 0;
        let forked = false;
        let foundCommand = false;
        let command = parse.getReader().getString();
        let original = parse.getContext().build(command);
		let contexts: Array<CommandContext<S>> = [];
		contexts.push(original)
        let next: CommandContext<S>[] = null;
        while (!(contexts == null)) {            
            for (let i = 0; i < contexts.length; i++) {
                let context: CommandContext<S> = contexts[i];
                let child: CommandContext<S> = context.getChild();
                if (!(child == null)) {
                    forked = forked || context.isForked();
                    if (child.hasNodes()) {
                        foundCommand = true;
                        let modifier: RedirectModifier<S> = context.getRedirectModifier();
                        if (modifier == null) {
                            if (next == null) 
                                next = [];
                            next.push(child.copyFor(context.getSource()));
                        }
                        else {
                            try {
                                let results: Array<S> = modifier.apply(context);
                                if (results.length !== 0) {
                                    if (next == null)
                                        next = []                                    
                                    
                                    for (let source of results) {
                                        next.push(child.copyFor(source));
                                    }
                                    
                                }                                
                            }
                            catch (ex) {                                                    
								this.consumer.onCommandComplete(context, false, 0);
								if (!forked)
									throw ex;
							}
                        }                        
                    }
                    
                } else if (context.getCommand() != null) {
                    foundCommand = true;
                    try {					
                        let value = await context.getCommand()(context);
                        result += value;
                        this.consumer.onCommandComplete(context, true, value);
                        successfulForks++;
                    } catch (ex) {
						this.consumer.onCommandComplete(context, false, 0);
						if (!forked)
							throw ex;
                    }                                                        
                }
                
            }
            
            contexts = next;
            next = null;
        }
        
        if (!foundCommand) {
            this.consumer.onCommandComplete(original, false, 0);
            throw CommandSyntaxException.BUILT_IN_EXCEPTIONS.dispatcherUnknownCommand().createWithContext(parse.getReader());
        }
        
        return forked ? successfulForks : result;
    }        
    
    public parse(command: string | StringReader, source: S): ParseResults<S> {
		if (typeof command === "string") 
			command = new StringReader(command)
		
        let context: CommandContextBuilder<S> = new CommandContextBuilder(this, source, this.root, command.getCursor());
        return this.parseNodes(this.root, command, context);
    }
    
    private parseNodes(node: CommandNode<S>, originalReader: StringReader, contextSoFar: CommandContextBuilder<S>): ParseResults<S> {

        let source: S = contextSoFar.getSource();
        let errors: Map<CommandNode<S>, CommandSyntaxException> = null;
        let potentials: ParseResults<S>[] = null;
        let cursor = originalReader.getCursor();
        for (let child of node.getRelevantNodes(originalReader)) {
            if (!child.canUse(source)) 
                continue;
                        
            let context: CommandContextBuilder<S> = contextSoFar.copy();
            let reader: StringReader = new StringReader(originalReader);
            try {                
				child.parse(reader, context);
                                
                if (reader.canRead())
                    if (reader.peek() != ARGUMENT_SEPARATOR)
                        throw CommandSyntaxException.BUILT_IN_EXCEPTIONS.dispatcherExpectedArgumentSeparator().createWithContext(reader);
            }
            catch (ex) {
				if (errors == null) {
					errors = new Map();
				}
				errors.set(child, ex);
				reader.setCursor(cursor);
				continue;				
            }                        
                        
            context.withCommand(child.getCommand());
            if (reader.canRead(child.getRedirect() == null ? 2 : 1)) {
				reader.skip();
                if (!(child.getRedirect() == null)) {
					let childContext: CommandContextBuilder<S> = new CommandContextBuilder(this, source, child.getRedirect(), reader.getCursor());
					let parse: ParseResults<S> = this.parseNodes(child.getRedirect(), reader, childContext);
					context.withChild(parse.getContext());
					return new ParseResults(context, parse.getReader(), parse.getExceptions());
				}
				else {
					let parse: ParseResults<S> = this.parseNodes(child, reader, context);
					if (potentials == null) {
						potentials = [];
					}
					
					potentials.push(parse);
				}
            } else {
				if (potentials == null) {
					potentials = [];
				}			
				potentials.push(new ParseResults(context, reader, new Map()));
			}                               
		}
		
		if (!(potentials == null)) {
            if (potentials.length > 1) {
                potentials.sort((a, b) => {
                    if (!a.getReader().canRead() && b.getReader().canRead()) {
                        return -1;
                    }
                    if (a.getReader().canRead() && !b.getReader().canRead()) {
                        return 1;
                    }
                    if (a.getExceptions().size === 0 && b.getExceptions().size !== 0) {
                        return -1;
                    }
                    if (a.getExceptions().size !== 0 && b.getExceptions().size === 0) {
                        return 1;
                    }
                    return 0;
                });
            }
            return potentials[0];
        }

        return new ParseResults<S>(contextSoFar, originalReader, errors == null ? new Map() : errors);
	}

    public getAllUsage(node: CommandNode<S>, source: S, restricted: boolean): string[] {
        const result: Array<string> = [];
        this.__getAllUsage(node, source, result, "", restricted);
        return result;
    }
    
    private __getAllUsage(node: CommandNode<S>, source: S, result: string[], prefix = "", restricted: boolean) {
        if (restricted && !node.canUse(source)) {
            return;
        }
		
        if (node.getCommand() != null) {		
            result.push(prefix);
        }
		
        if (node.getRedirect() != null) {
            const redirect = node.getRedirect() === this.root ? "..." : "-> " + node.getRedirect().getUsageText();
            result.push(prefix.length === 0 ? node.getUsageText() + ARGUMENT_SEPARATOR + redirect : prefix + ARGUMENT_SEPARATOR + redirect);
        }
        else if (node.getChildrenCount() > 0) {
            for (let child of node.getChildren()) {
                this.__getAllUsage(child, source, result, prefix.length === 0 ? child.getUsageText() : prefix + ARGUMENT_SEPARATOR + child.getUsageText(), restricted);
            }
            
        }
        
    }
    
    public getSmartUsage(node: CommandNode<S>, source: S): Map<CommandNode<S>, string> {
		let result = new Map<CommandNode<S>, string>();
		
        let optional = node.getCommand() !== null;
        for (let child of node.getChildren()) {
            let usage = this.__getSmartUsage(child, source, optional, false);
            if (!(usage == null)) {
                result.set(child, usage);
            }            
        }
        
        return result;
    }
    
    private __getSmartUsage(node: CommandNode<S>, source: S, optional: boolean, deep: boolean): string {
        if (!node.canUse(source)) {
            return null;
        }
        
        let self = optional ? USAGE_OPTIONAL_OPEN + node.getUsageText() + USAGE_OPTIONAL_CLOSE : node.getUsageText();
        let childOptional = node.getCommand() != null;
        let open = childOptional ? USAGE_OPTIONAL_OPEN : USAGE_REQUIRED_OPEN;
        let close = childOptional ? USAGE_OPTIONAL_CLOSE : USAGE_REQUIRED_CLOSE;
        
        if (!deep) {
            if ((node.getRedirect() != null)) {
                let redirect = node.getRedirect() == this.root ? "..." : "-> " + node.getRedirect().getUsageText();
				return self + ARGUMENT_SEPARATOR + redirect;
            }
            else {
                let children: CommandNode<S>[] = [...node.getChildren()].filter(c => c.canUse(source));
                if ((children.length == 1)) {
                    let usage = this.__getSmartUsage(children[0], source, childOptional, childOptional);
					if (!(usage == null)) {
                        return self + ARGUMENT_SEPARATOR + usage;
                    }
                }
                else if (children.length > 1) {
                    let childUsage = new Set<string>();
                    for (let child of children) {
                        let usage = this.__getSmartUsage(child, source, childOptional, true);
                        if (!(usage == null)) {
                            childUsage.add(usage);
                        }                        
                    }                    
                    if (childUsage.size === 1) {
                        let usage = childUsage.values().next().value;
                        return self + ARGUMENT_SEPARATOR + (childOptional ? USAGE_OPTIONAL_OPEN + usage + USAGE_OPTIONAL_CLOSE : usage);
                    }
                    else if (childUsage.size > 1) {
                        let builder = open;
                        let count = 0;
                        for (let child of children) {
                            if (count > 0) {
                                builder += USAGE_OR;
                            }                            
                            builder += child.getUsageText();
                            count++;
                        }                        
                        if (count > 0) {
                            builder += close;
                            return self + ARGUMENT_SEPARATOR + builder;
                        }                        
                    }                    
                }                
            }            
        }        
        return self;
    }    
    
    public async getCompletionSuggestions(parse: ParseResults<S>, cursor = parse.getReader().getTotalLength()): Promise<Suggestions> {
        let context: CommandContextBuilder<S> = parse.getContext();
        let nodeBeforeCursor: SuggestionContext<S> = context.findSuggestionContext(cursor);
        let parent: CommandNode<S> = nodeBeforeCursor.parent;
        let start = Math.min(nodeBeforeCursor.startPos, cursor);
        let fullInput = parse.getReader().getString();
		let truncatedInput = fullInput.substring(0, cursor);        
        let futures = [];        
        for (let node of parent.getChildren()) {
            let future = await Suggestions.empty();
            try {
                future = await node.listSuggestions(context.build(truncatedInput), new SuggestionsBuilder(truncatedInput, start));
            }
            catch (ignored) {
            }            
            futures.push(future);
        }
		
		return Promise.resolve(Suggestions.merge(fullInput, futures));
    }
    
    public getRoot(): RootCommandNode<S> {
        return this.root;
    }
    
    public getPath(target: CommandNode<S>): string[] {
        let nodes: Array<Array<CommandNode<S>>> = [];
        this.addPaths(this.root, nodes, []);
        for (let list of nodes) {
            if (list[list.length - 1] === target) {
                let result = [];
                for (let node of list) {
                    if (node !== this.root) {
                        result.push(node.getName());
                    }                    
                }                
                return result;
            }            
        }        
        return [];
    }
    
    public findNode(path: string[]): CommandNode<S> {
        let node: CommandNode<S> = this.root;
        for (let name of path) {
            node = node.getChild(name);
            if (node == null)
                return null;            
        }        
        return node;
    }
    
    public findAmbiguities(consumer: AmbiguityConsumer<S>) {
        this.root.findAmbiguities(consumer);
    }
    
    private addPaths(node: CommandNode<S>, result: Array<Array<CommandNode<S>>>, parents: Array<CommandNode<S>>): void {
		let current: Array<CommandNode<S>> = [];
		current.push(...parents);
        current.push(node);
        result.push(current);
        for (let child of node.getChildren())
            this.addPaths(child, result, current);            
	}
}