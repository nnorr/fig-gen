// State machine written directly in the clocked block (no next-state variable).
module fsm_seq (
    input  logic clk,
    input  logic rst,
    input  logic req,
    input  logic ack,
    output logic grant
);
  localparam logic [1:0] WAIT = 2'b00;
  localparam logic [1:0] GRANT = 2'b01;
  localparam logic [1:0] HOLD = 2'b10;

  logic [1:0] state;

  always_ff @(posedge clk) begin
    if (rst) begin
      state <= WAIT;
    end else begin
      case (state)
        WAIT: if (req) state <= GRANT;
        GRANT: if (ack) state <= HOLD;
        HOLD: if (!req) state <= WAIT;
        default: state <= WAIT;
      endcase
    end
  end

  assign grant = state == GRANT;
endmodule
