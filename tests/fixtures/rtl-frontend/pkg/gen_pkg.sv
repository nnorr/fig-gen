// Generic package: an enum state type with implicit, decimal and binary
// encodings, a packed struct, and a packed array of that struct.
package gen_pkg;
  localparam int W = 8;
  typedef enum logic [2:0] {
    StIdle,
    StLoad = 3'd3,
    StRun,
    StDone = 3'b111
  } state_e;
  typedef struct packed {
    logic       busy;
    logic [3:0] count;
    logic [2:0] tag;
  } status_t;
  typedef status_t [1:0] status_pair_t;
endpackage
