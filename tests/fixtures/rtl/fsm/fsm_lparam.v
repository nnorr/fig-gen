// Localparam-encoded 4-state machine: case in a combinational block on
// state_d/state_q, a conditional assignment and a multi-label case item.
module fsm_lparam (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       go,
    input  wire       last,
    input  wire [1:0] mode,
    output reg        load
);
  localparam S_IDLE = 2'd0;
  localparam S_RUN = 2'd1;
  localparam S_DRAIN = 2'd2;
  localparam S_DONE = 2'd3;
  localparam MODE_OFF = 2'd3;

  reg [1:0] state_q;
  reg [1:0] state_d;

  always @(*) begin
    state_d = state_q;
    load = 1'b0;
    case (state_q)
      S_IDLE: begin
        if (go && mode != MODE_OFF) begin
          state_d = S_RUN;
          load = 1'b1;
        end
      end
      S_RUN: state_d = last ? S_DRAIN : S_RUN;
      S_DRAIN, S_DONE: begin
        if (!go) state_d = S_IDLE;
      end
      default: state_d = S_IDLE;
    endcase
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) state_q <= S_IDLE;
    else state_q <= state_d;
  end
endmodule
