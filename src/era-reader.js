// era-reader.js
// Copyright 2013-2015 Ross Angle. Released under the MIT License.
"use strict";

// This is a reader for Era's own dialect of s-expressions.

// To make string literals convenient, we implement an interpolated
// string syntax according to the following design sketch:
//
// reader macro \ followed by ( will read a string terminated by ),
//   and it results in the string contents, which means a list of
//   strings interspersed with other values, and then it will
//   postprocess whitespace as described further below
// reader macro \ followed by [ will read a string terminated by ],
//   and it results in the string contents, which means a list of
//   strings interspersed with other values, and then it will
//   postprocess whitespace as described further below
// any raw Unicode code point except space, tab, carriage return,
//   newline, \, (, ), [, and ] is used directly and has no other
//   meaning
// whitespace tokens:
//   \s means a single space
//   \t means a tab
//   \r means a carriage return
//   \n means a newline
//   \# means empty string
// non-whitespace tokens:
//   \- means backslash
//   ( reads a string terminated by ) and means the contents of that
//     string plus both brackets, without postprocessing whitespace
//   [ reads a string terminated by ] and means the contents of that
//     string plus both brackets, without postprocessing whitespace
//   \( reads a string terminated by ) while boosting the
//     quasiquotation depth by 1, and it means the contents of the
//     string plus both brackets, without postprocessing whitespace
//   \[ reads a string terminated by ] while boosting the
//     quasiquotation depth by 1, and it means the contents of the
//     string plus both brackets, without postprocessing whitespace
//   ) is an error unless it terminates the current string reader
//   ] is an error unless it terminates the current string reader
//   \< means left square bracket
//   \> means right square bracket
//   \{ means left parenthesis
//   \} means right parenthesis
//   \; followed by the rest of a line means empty string (for
//     comments)
//   \_ followed by a non-infix s-expression followed by . is that
//     s-expression; this is one of the "other values" interspersed
//     with actual strings in the result
//     // NOTE: The reason we choose the character . here is that it's
//     // already an infix operator, so it will be left behind by a
//     // non-infix s-expression. The reason we have a terminating
//     // character at all is so the s-expression reader can consume
//     // all the whitespace before that, leaving the whitespace
//     // after that for the string reader to process.
//   \u followed by 1-6 uppercase hexadecimal digits followed by .
//     means the appropriate Unicode code point, unless it's a code
//     point value outside the Unicode range or reserved for UTF-16
//     surrogates, in which case it's an error
//     // NOTE: The reason we choose the character . here is for
//     // consistency with the \_ escape sequence. The reason we have
//     // a terminating character at all is so the following character
//     // can be a hex digit without ambiguity.
// postprocess whitespace according to the following rules:
//   - remove all raw whitespace adjacent to the ends of the string
//   - remove all raw whitespace adjacent to whitespace escapes
//   - replace every remaining occurrence of one or more raw
//     whitespace characters with a single space
//
// The quasiquotation depth is a nonnegative integer that's usually 0.
// All \ escape sequences except \( and \[ actually vary depending on
// this depth. They really begin with \ followed by a number of ,
// equal to the depth. For instance, at a depth of 2, the \n escape
// sequence must actually be written as \,,n in the code. If any of
// these escape sequences appears with fewer commas than the depth,
// it's still parsed the same way, but the result is the unprocessed
// text.


// $.stream.readc
// $.stream.peekc
// $.readerMacros
// $.heedsCommandEnds
// $.infixLevel
// $.infixState
// $.qqDepth
// $.end
// $.unrecognized

function reader( $, then ) {
    $.stream.peekc( function ( c ) {
        if ( c === "" )
            return void $.end( $, then );
        var readerMacro = $.readerMacros.get( c );
        if ( readerMacro === void 0 )
            return void $.unrecognized( $, then );
        readerMacro( $, then );
    } );
}
function addReaderMacros( readerMacros, string, func ) {
    eachUnicodeCodePoint( string, function ( codePointInfo ) {
        readerMacros.set( codePointInfo.charString, func );
    } );
}
function bankInfix( $, minInfixLevel, then ) {
    var result = $.infixState.type === "ready" &&
        minInfixLevel <= $.infixLevel;
    if ( result )
        then( $, { ok: true, val: $.infixState.val } );
    return result;
}
function bankCommand( $, then ) {
    var result = $.infixState.type === "ready" && $.heedsCommandEnds;
    if ( result )
        then( $, { ok: true, val: $.infixState.val } );
    return result;
}
function continueInfix( $, val, then ) {
    if ( $.infixState.type === "empty" ) {
        reader( objPlus( $, {
            infixState: { type: "ready", val: val }
        } ), then );
    } else if ( $.infixState.type === "ready" ) {
        throw new Error(
            "Read a second complete value before realizing this " +
            "wasn't an infix expression." );
    } else {
        throw new Error();
    }
}
// NOTE: The readListUntilParen() function is only for use by the "("
// and "/" reader macros to reduce duplication.
function readListUntilParen( $, consumeParen, then ) {
    function loop( $, list ) {
        reader( objPlus( $, {
            heedsCommandEnds: false,
            readerMacros: $.readerMacros.plusEntry( ")",
                function ( $sub, then ) {
                
                if ( bankInfix( $sub, 0, then ) )
                    return;
                
                if ( consumeParen )
                    $sub.stream.readc( function ( c ) {
                        next();
                    } );
                else
                    next();
                
                function next() {
                    // TODO: Make this trampolined with constant time
                    // between bounces. This might be tricky because
                    // it's stateful.
                    var result = [];
                    for ( var ls = list; ls !== null; ls = ls.past )
                        result.unshift( ls.last );
                    then( $sub, { ok: true, val:
                        { type: "freshlyCompletedCompound",
                            val: result } } );
                }
            } ),
            infixLevel: 0,
            infixState: { type: "empty" },
            end: function ( $sub, then ) {
                then( $sub, { ok: false, msg: "Incomplete list" } );
            }
        } ), function ( $sub, result ) {
            if ( !result.ok )
                return void then( $, result );
            
            if ( likeObjectLiteral( result.val )
                && result.val.type === "freshlyCompletedCompound" )
                continueInfix( $, result.val.val, then );
            else
                loop( $, { past: list, last: result.val } );
        } );
    }
    $.stream.readc( function ( c ) {
        loop( $, null );
    } );
}

var symbolChars = "abcdefghijklmnopqrstuvwxyz";
symbolChars += symbolChars.toUpperCase() + "-*0123456789";
var symbolChopsChars = strMap().setObj( { "(": ")", "[": "]" } );
var commandEndChars = "\r\n";
var whiteChars = " \t";

function postprocessWhitespace( stringParts ) {
    // TODO: Make this trampolined with constant time between bounces.
    // This might be tricky because it's stateful.
    
    // Remove all raw whitespace adjacent to the ends of the string
    // and adjacent to whitespace escapes.
    function removeAfterStartOrExplicitWhitespace( parts ) {
        var parts2 = [];
        var removing = true;
        arrEach( parts, function ( part ) {
            if ( part.type === "interpolation" ) {
                parts2.push( part );
                removing = false;
            } else if ( part.type === "rawWhite" ) {
                if ( !removing )
                    parts2.push( part );
            } else if ( part.type === "explicitWhite" ) {
                parts2.push( part );
                removing = true;
            } else if ( part.type === "nonWhite" ) {
                parts2.push( part );
                removing = false;
            } else {
                throw new Error();
            }
        } );
        return parts2;
    }
    var stringParts2 = removeAfterStartOrExplicitWhitespace(
        stringParts ).reverse();
    var stringParts3 = removeAfterStartOrExplicitWhitespace(
        stringParts2 ).reverse();
    
    // Replace every remaining occurrence of one or more raw
    // whitespace characters with a single space. Meanwhile, drop the
    // distinction between raw whitespace, explicit whitespace, and
    // non-whitespace text.
    var resultParts = [];
    var currentText = "";
    var removing = true;
    arrEach( stringParts3, function ( part ) {
        if ( part.type === "interpolation" ) {
            resultParts.push(
                { type: "text", text: currentText },
                { type: "interpolation", val: part.val } );
            currentText = "";
            removing = false;
        } else if ( part.type === "rawWhite" ) {
            if ( !removing ) {
                currentText += " ";
                removing = true;
            }
        } else if ( part.type === "explicitWhite" ) {
            currentText += part.text;
            removing = false;
        } else if ( part.type === "nonWhite" ) {
            currentText += part.text;
            removing = false;
        } else {
            throw new Error();
        }
    } );
    resultParts.push( { type: "text", text: currentText } );
    return { type: "interpolatedString", parts: resultParts };
}

function ignoreRestOfLine( $, then ) {
    $.stream.peekc( function ( c ) {
        if ( /^[\r\n]?$/.test( c ) )
            then();
        else
            $.stream.readc( function ( c ) {
                ignoreRestOfLine( $, then );
            } );
    } );
}

var whiteReaderMacros = strMap();
whiteReaderMacros.set( ";", function ( $, then ) {
    if ( bankCommand( $, then ) )
        return;
    ignoreRestOfLine( $, function () {
        reader( $, then );
    } );
} );
addReaderMacros( whiteReaderMacros, commandEndChars,
    function ( $, then ) {
    
    if ( bankCommand( $, then ) )
        return;
    $.stream.readc( function ( c ) {
        reader( $, then );
    } );
} );
addReaderMacros( whiteReaderMacros, whiteChars, function ( $, then ) {
    $.stream.readc( function ( c ) {
        reader( $, then );
    } );
} );

var readerMacros = whiteReaderMacros.copy();
addReaderMacros( readerMacros, symbolChars, function ( $, then ) {
    if ( bankInfix( $, 0, then ) )
        return;
    function collectChops( stringSoFar, open, close, nesting ) {
        if ( nesting === 0 )
            return void collect( stringSoFar );
        $.stream.readc( function ( c ) {
            var nextStringSoFar = stringSoFar + c;
            if ( c === "" )
                return void then( $,
                    { ok: false, msg: "Incomplete symbol" } );
            collectChops( nextStringSoFar, open, close,
                nesting + (c === open ? 1 : c === close ? -1 : 0) );
        } );
    }
    function collect( stringSoFar ) {
        $.stream.peekc( function ( c ) {
            if ( c === ""
                || (symbolChars.indexOf( c ) === -1
                    && !symbolChopsChars.has( c )) )
                return void continueInfix( $, stringSoFar, then );
            $.stream.readc( function ( open ) {
                var nextStringSoFar = stringSoFar + open;
                var close = symbolChopsChars.get( open );
                if ( close !== void 0 )
                    collectChops( nextStringSoFar, open, close, 1 );
                else
                    collect( nextStringSoFar );
            } );
        } );
    }
    collect( "" );
} );
readerMacros.set( "(", function ( $, then ) {
    if ( bankInfix( $, 0, then ) )
        return;
    readListUntilParen( $, !!"consumeParen", then );
} );
readerMacros.set( "/", function ( $, then ) {
    if ( bankInfix( $, 0, then ) )
        return;
    readListUntilParen( $, !"consumeParen", then );
} );
readerMacros.set( "\\", function ( $, then ) {
    if ( bankInfix( $, 0, then ) )
        return;
    $.stream.readc( function ( c ) {
        reader( objPlus( $, {
            readerMacros: symbolChopsChars.map(
                function ( closeBracket, openBracket ) {
                
                return function ( $sub, then ) {
                    readStringUntilBracket( $, closeBracket, 0,
                        function ( $, result ) {
                        
                        if ( result.ok )
                            then( $, { ok: true,
                                val: postprocessWhitespace(
                                    result.val ) } );
                        else
                            then( $, result );
                    } );
                };
            } ),
            unrecognized: function ( $sub, then ) {
                then( $sub, { ok: false,
                    msg: "Unrecognized string opening character" } );
            },
            end: function ( $sub, then ) {
                then( $sub, { ok: false, msg: "Incomplete string" } );
            }
        } ), then );
    } );
} );
function defineInfixOperator(
    ch, level, noLhsErr, incompleteErr, readRemaining ) {
    
    readerMacros.set( ch, function ( $, then ) {
        if ( bankInfix( $, level, then ) )
            return;
        if ( $.infixState.type === "empty" ) {
            then( $, { ok: false, msg: noLhsErr } );
        } else if ( $.infixState.type === "ready" ) {
            var lhs = $.infixState.val;
            var origHeedsCommandEnds = $.heedsCommandEnds;
            var $sub1 = objPlus( $, {
                infixState: { type: "empty" }
            } );
            $sub1.stream.readc( function ( c ) {
                function read( heedsCommandEnds, level, then ) {
                    reader( objPlus( $sub1, {
                        heedsCommandEnds:
                            origHeedsCommandEnds && heedsCommandEnds,
                        infixLevel: level,
                        infixState: { type: "empty" },
                        end: function ( $sub2, then ) {
                            if ( $sub2.infixState.type === "ready" )
                                then( $sub1, { ok: true,
                                    val: $sub2.infixState.val } );
                            else
                                then( $sub1, { ok: false,
                                    msg: incompleteErr } );
                        }
                    } ), then );
                }
                function expectChar( heedsCommandEnds, ch, then ) {
                    reader( objPlus( $sub1, {
                        heedsCommandEnds:
                            origHeedsCommandEnds && heedsCommandEnds,
                        readerMacros: whiteReaderMacros.plusEntry( ch,
                            function ( $sub2, then ) {
                            
                            $sub2.stream.readc( function ( c ) {
                                then( $sub1,
                                    { ok: true, val: null } );
                            } );
                        } ),
                        unrecognized: function ( $sub2, then ) {
                            then( $sub1, { ok: false, msg:
                                "Encountered an unrecognized " +
                                "character when expecting " + ch } );
                        },
                        end: function ( $sub2, then ) {
                            then( $sub1,
                                { ok: false, msg: incompleteErr } );
                        }
                    } ), then );
                }
                readRemaining( lhs, read, expectChar,
                    function ( $sub2, result ) {
                    
                    if ( !result.ok )
                        return void then( $sub1, result );
                    continueInfix( $sub1, result.val, then );
                } );
            } );
        } else {
            throw new Error();
        }
    } );
}
// NOTE: A previous syntax for `a<b>c` was `a :b c`. The newer syntax
// is visually symmetrical, but more importantly, it does not require
// whitespace between `b` and `c`. The lack of whitespace makes it
// easier to visually group it among list elements like (a b c<d>e f),
// and it makes multi-line infix expressions look even more unusual.
// This saves us from multi-line infix indentation dilemmas because it
// discourages us from writing such expressions in the first place.
defineInfixOperator( "<", 1,
    "Tertiary infix expression without lhs",
    "Incomplete tertiary infix expression",
    function ( lhs, read, expectChar, then ) {
    
    // NOTE: We support top-level code like the following by disabling
    // heedsCommandEnds when reading the operator:
    //
    //  a <b
    //      .c> d
    //
    read( !"heedsCommandEnds", 0, function ( $, op ) {
        if ( !op.ok )
            return void then( $, op );
        expectChar( !"heedsCommandEnds", ">", function ( $, status ) {
            if ( !status.ok )
                return void then( $, status );
            read( !!"heedsCommandEnds", 1, function ( $, rhs ) {
                if ( !rhs.ok )
                    return void then( $, rhs );
                then( $,
                    { ok: true, val: [ op.val, lhs, rhs.val ] } );
            } );
        } );
    } );
} );
readerMacros.set( ">", function ( $, then ) {
    if ( bankInfix( $, 0, then ) )
        return;
    then( $, { ok: false,
        msg: "Tertiary infix expression without lhs or operator" } );
} );
defineInfixOperator( ".", 2,
    "Binary infix expression without lhs",
    "Incomplete binary infix expression",
    function ( lhs, read, expectChar, then ) {
    
    read( !!"heedsCommandEnds", 2, function ( $, rhs ) {
        if ( !rhs.ok )
            return void then( $, rhs );
        then( $, { ok: true, val: [ lhs, rhs.val ] } );
    } );
} );

function readStringUntilBracket( $, bracket, qqDepth, then ) {
    function loop( $, string ) {
        reader( objPlus( $, {
            qqDepth: qqDepth,
            readerMacros: stringReaderMacros.plusEntry( bracket,
                function ( $sub, then ) {
                
                $sub.stream.readc( function ( c ) {
                    // TODO: Make this trampolined with constant time
                    // between bounces. This might be tricky because
                    // it's stateful.
                    var result = [];
                    for ( var s = string; s !== null; s = s.past )
                        result = s.last.concat( result );
                    then( $sub, { ok: true, val:
                        { type: "freshlyCompletedCompound",
                            val: result } } );
                } );
            } ),
            unrecognized: function ( $sub, then ) {
                $sub.stream.readc( function ( c ) {
                    then( $sub, { ok: true,
                        val: [ { type: "nonWhite", text: c } ] } );
                } );
            },
            end: function ( $sub, then ) {
                then( $sub, { ok: false, msg: "Incomplete string" } );
            }
        } ), function ( $, result ) {
            if ( !result.ok )
                return void then( $, result );
            
            if ( likeObjectLiteral( result.val )
                && result.val.type === "freshlyCompletedCompound" )
                then( $, { ok: true, val: result.val.val } );
            else
                loop( $, { past: string, last: result.val } );
        } );
    }
    $.stream.readc( function ( c ) {
        loop( $, null );
    } );
}

var stringReaderMacros = strMap();
stringReaderMacros.setAll( strMap().setObj( {
    " ": " ",
    "\t": "\t",
    "\r": "\r",
    "\n": "\n"
} ).map( function ( text ) {
    return function ( $, then ) {
        $.stream.readc( function ( c ) {
            then( $, { ok: true,
                val: [ { type: "rawWhite", text: text } ] } );
        } );
    };
} ) );
symbolChopsChars.each( function ( openBracket, closeBracket ) {
    stringReaderMacros.set( openBracket, function ( $, then ) {
        readStringUntilBracket( $, closeBracket, $.qqDepth,
            function ( $, result ) {
            
            if ( result.ok )
                then( $, { ok: true, val: [].concat(
                    [ { type: "nonWhite", text: openBracket } ],
                    result.val,
                    [ { type: "nonWhite", text: closeBracket } ]
                ) } );
            else
                then( $, result );
        } );
    } );
    stringReaderMacros.set( closeBracket, function ( $, then ) {
        then( $, { ok: false,
            msg: "Unmatched " + closeBracket + " in string" } );
    } );
} );
stringReaderMacros.set( "\\", function ( $, then ) {
    loop( "", -1 );
    function loop( escStart, escQqDepth ) {
        if ( $.qqDepth < escQqDepth )
            return void then( $, { ok: false,
                msg: "Unquoted past the quasiquotation depth" } );
        
        $.stream.readc( function ( c1 ) {
            $.stream.peekc( function ( c2 ) {
                if ( c2 === "," )
                    loop( escStart + c1, escQqDepth + 1 );
                else
                    next( escStart + c1, escQqDepth + 1 );
            } );
        } );
    }
    function next( escStart, escQqDepth ) {
        function makeCapturingStream( underlyingStream ) {
            var captured = "";
            
            var stream = {};
            stream.peekc = function ( then ) {
                underlyingStream.peekc( then );
            };
            stream.readc = function ( then ) {
                underlyingStream.readc( function ( c ) {
                    captured += c;
                    then( c );
                } );
            };
            
            var result = {};
            result.stream = stream;
            result.getCaptured = function () {
                return captured;
            };
            return result;
        }
        
        var inStringWithinString = escQqDepth < $.qqDepth;
        var capturing = inStringWithinString ?
            makeCapturingStream( $.stream ) :
            { stream: $.stream };
        
        reader( objPlus( $, {
            stream: capturing.stream,
            readerMacros: strMap().setAll( strMap().setObj( {
                "s": " ",
                "t": "\t",
                "r": "\r",
                "n": "\n",
                "#": ""
            } ).map( function ( text, escName ) {
                return function ( $sub, then ) {
                    $sub.stream.readc( function ( c ) {
                        then( $sub, { ok: true, val:
                            [ { type: "explicitWhite", text: text } ]
                        } );
                    } );
                };
            } ) ).setAll( strMap().setObj( {
                "-": "\\",
                "<": "[",
                ">": "]",
                "{": "(",
                "}": ")"
            } ).map( function ( text, escName ) {
                return function ( $sub, then ) {
                    $sub.stream.readc( function ( c ) {
                        then( $sub, { ok: true, val:
                            [ { type: "nonWhite", text: text } ]
                        } );
                    } );
                };
            } ) ).setAll( symbolChopsChars.map(
                function ( closeBracket, openBracket ) {
                
                // NOTE: Unlike the rest of these escape sequences,
                // this one directly uses `$` instead of `$sub`. It
                // does to bypass the makeCapturingStream() behavior
                // on `$sub.stream`, which would otherwise suppress
                // *all* escape sequences occurring inside this one's
                // boundaries.
                
                return function ( $sub, then ) {
                    if ( $sub.qqDepth !== 0 )
                        return void then( $sub, { ok: false, msg:
                            "Used a string-within-a-string escape " +
                            "sequence with an unquote level other " +
                            "than zero" } );
                    
                    readStringUntilBracket(
                        $, closeBracket, $sub.qqDepth + 1,
                        function ( $, result ) {
                        
                        if ( result.ok )
                            then( $, { ok: true, val: [].concat(
                                [ { type: "nonWhite", text:
                                    escStart + openBracket } ],
                                result.val,
                                [ { type: "nonWhite",
                                    text: closeBracket } ]
                            ) } );
                        else
                            then( $, result );
                    } );
                };
            } ) ).setObj( {
                ";": function ( $sub, then ) {
                    return void ignoreRestOfLine( $sub, function () {
                        then( $sub, { ok: true, val: [] } );
                    } );
                },
                "_": function ( $sub, then ) {
                    $sub.stream.readc( function ( c ) {
                        reader( objPlus( $sub, {
                            heedsCommandEnds: false,
                            infixLevel: 3,
                            infixState: { type: "empty" },
                            readerMacros: readerMacros,
                            unrecognized: function ( $sub2, then ) {
                                then( $sub2, { ok: false, msg:
                                    "Encountered an unrecognized " +
                                    "character" } );
                            },
                            end: function ( $sub2, then ) {
                                then( $sub2, { ok: false, msg:
                                    "Incomplete interpolation in " +
                                    "string" } );
                            }
                        } ), function ( $sub, result ) {
                            if ( !result.ok )
                                return void then( $sub, result );
                            $sub.stream.readc( function ( c ) {
                                if ( c === "." )
                                    then( $sub, { ok: true, val:
                                        [ {
                                            type: "interpolation",
                                            val: result.val
                                        } ]
                                    } );
                                else
                                    then( $sub, { ok: false, val:
                                        "Didn't end a string " +
                                        "interpolation with a " +
                                        "dot" } );
                            } );
                        } );
                    } );
                },
                "u": function ( $sub, then ) {
                    $sub.stream.readc( function ( c ) {
                        loop( "", 6 );
                        function loop( hexSoFar, digitsLeft ) {
                            $sub.stream.readc( function ( c ) {
                                if ( c === "" )
                                    then( $sub, { ok: false, msg:
                                        "Incomplete Unicode escape"
                                    } );
                                else if ( c === "." )
                                    next( hexSoFar );
                                else if ( digitsLeft === 0 )
                                    then( $sub, { ok: false, msg:
                                        "Unterminated Unicode escape"
                                    } );
                                else if ( /^[01-9A-F]$/.test( c ) )
                                    loop( hexSoFar + c,
                                        digitsLeft - 1 );
                                else
                                    then( $sub, { ok: false, msg:
                                        "Unrecognized character in " +
                                        "Unicode escape" } );
                            } );
                        }
                        function next( hex ) {
                            if ( hex.length === 0 )
                                return void then( $sub,
                                    { ok: false, msg:
                                        "Unicode escape with no " +
                                        "digits" } );
                            var text = unicodeCodePointToString(
                                parseInt( hex, 16 ) );
                            if ( text === null )
                                return void then( $sub,
                                    { ok: false, msg:
                                        "Unicode escape out of range"
                                    } );
                            then( $sub, { ok: true, val:
                                [ { type: "nonWhite", text: text } ]
                            } );
                        }
                    } );
                },
                ",": function ( $sub, then ) {
                    // NOTE: We shouldn't get here. We already read
                    // all the commas first.
                    then( $sub, { ok: false, msg:
                        "Unquoted past the quasiquotation depth, " +
                        "and also caused an internal error in the " +
                        "reader" } );
                }
            } ),
            unrecognized: function ( $sub, then ) {
                then( $sub, { ok: false,
                    msg: "Unrecognized escape sequence" } );
            },
            end: function ( $sub, then ) {
                then( $sub, { ok: false,
                    msg: "Incomplete escape sequence" } );
            }
        } ), function ( $sub, result ) {
            if ( result.ok && inStringWithinString )
                then( $, { ok: true, val: [ {
                    type: "nonWhite",
                    text: escStart + capturing.getCaptured()
                } ] } );
            else
                then( $, result );
        } );
    }
} );


function stringStream( defer, string ) {
    if ( !isValidUnicode( string ) )
        throw new Error();
    var i = 0, n = string.length;
    function readOrPeek( isReading, then ) {
        defer( function () {
            if ( n <= i )
                return void then( "" );
            var charCodeInfo =
                getUnicodeCodePointAtCodeUnitIndex( string, i );
            var result = charCodeInfo.charString;
            if ( isReading )
                i += result.length;
            then( result );
        } );
    }
    var stream = {};
    stream.peekc = function ( then ) {
        readOrPeek( !"isReading", then );
    };
    stream.readc = function ( then ) {
        readOrPeek( !!"isReading", then );
    };
    return stream;
}

function makeDeferTrampoline() {
    // TODO: Refactor this to be a trampoline with constant time
    // between bounces, like what Penknife and era-avl.js use.
    
    var deferTrampolineEvents = [];
    
    var result = {};
    result.defer = function ( func ) {
        deferTrampolineEvents.push( func );
    };
    result.runDeferTrampoline = function () {
        while ( deferTrampolineEvents.length !== 0 )
            deferTrampolineEvents.pop()();
    };
    return result;
}

function readAll( string ) {
    
    var deferTrampoline = makeDeferTrampoline();
    var stream = stringStream( deferTrampoline.defer, string );
    
    function read( stream, onEnd, onFailure, onSuccess ) {
        // TODO: Make this trampolined with constant time between
        // bounces. This might be tricky because it's stateful.
        var readResult;
        reader( {
            stream: stream,
            readerMacros: readerMacros,
            heedsCommandEnds: true,
            infixLevel: 0,
            infixState: { type: "empty" },
            end: function ( $, then ) {
                if ( $.infixState.type === "ready" )
                    then( $, { ok: true, val: $.infixState.val } );
                else
                    readResult = onEnd();
                deferTrampoline.runDeferTrampoline();
            },
            unrecognized: function ( $, then ) {
                then( $, { ok: false,
                    msg: "Encountered an unrecognized character" } );
                deferTrampoline.runDeferTrampoline();
            }
        }, function ( $, result ) {
            if ( result.ok )
                readResult = onSuccess( result.val );
            else
                readResult = onFailure( result.msg );
        } );
        deferTrampoline.runDeferTrampoline();
        return readResult;
    }
    
    return readNext( [] );
    function readNext( resultsSoFar ) {
        return read( stream, function () {  // onEnd
            return resultsSoFar;
        }, function ( message ) {  // onFailure
            return resultsSoFar.concat(
                [ { ok: false, msg: message } ] );
        }, function ( result ) {  // onSuccess
            return readNext( resultsSoFar.concat(
                [ { ok: true, val: result } ] ) );
        } );
    }
}
